import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as Ffmpeg from 'fluent-ffmpeg';
import * as FormData from 'form-data';

/** Parsed SRT segment */
interface SrtSegment {
  id: number;
  startTime: string; // "00:00:01,000"
  endTime: string; // "00:00:03,500"
  text: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

/** Per-segment processing result */
interface SegmentResult {
  segmentId: number;
  text: string;
  srtStartMs: number;
  srtEndMs: number;
  srtDurationMs: number;
  ttsDurationMs: number;
  tempoRatio: number;
  stretchedPath: string;
}

@Injectable()
export class AudioTtsService {
  private readonly logger = new Logger(AudioTtsService.name);
  private readonly xttsBaseUrl: string;

  constructor() {
    this.xttsBaseUrl =
      process.env.XTTS_SERVER_URL || 'http://localhost:8888';
  }

  // ─────────────────────────────────────────────
  // Public API methods
  // ─────────────────────────────────────────────

  /**
   * Get all available voices (built-in + cloned) from the XTTS server.
   */
  async getVoices(): Promise<any> {
    try {
      const { data } = await axios.get(
        `${this.xttsBaseUrl}/speakers`,
      );
      return data;
    } catch (error) {
      this.logger.error('Failed to fetch voices from XTTS server', error);
      throw new ServiceUnavailableException(
        'XTTS server is not available. Make sure it is running.',
      );
    }
  }

  /**
   * Get supported languages from the XTTS server.
   */
  async getLanguages(): Promise<any> {
    try {
      const { data } = await axios.get(
        `${this.xttsBaseUrl}/languages`,
      );
      return data;
    } catch (error) {
      this.logger.error('Failed to fetch languages', error);
      throw new ServiceUnavailableException(
        'XTTS server is not available.',
      );
    }
  }

  /**
   * Clone a voice by uploading a WAV file to the XTTS server.
   */
  async cloneVoice(
    name: string,
    description: string,
    filePath: string,
    originalFilename: string,
  ): Promise<any> {
    try {
      const form = new FormData();
      form.append('name', name);
      form.append('description', description || '');
      form.append('file', fs.createReadStream(filePath), {
        filename: originalFilename,
      });

      const { data } = await axios.post(
        `${this.xttsBaseUrl}/clone-voice`,
        form,
        { headers: form.getHeaders() },
      );

      return data;
    } catch (error) {
      const message =
        error?.response?.data?.detail ||
        error?.message ||
        'Unknown error';
      this.logger.error(`Voice cloning failed: ${message}`);
      throw new BadRequestException(
        `Voice cloning failed: ${message}`,
      );
    } finally {
      // Cleanup uploaded file
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  }

  /**
   * Process an SRT file: TTS each segment, stretch to match timeline, concatenate.
   * Returns the path to the final audio file.
   */
  async processSrt(
    srtFilePath: string,
    speaker: string | undefined,
    voiceId: string | undefined,
    language: string,
    outputFormat: string = 'wav',
  ): Promise<{ outputPath: string; outputFilename: string; segments: SegmentResult[] }> {
    const workDir = path.join(
      os.tmpdir(),
      `tts-srt-${Date.now()}`,
    );
    fs.mkdirSync(workDir, { recursive: true });

    try {
      // 1. Parse SRT
      const srtContent = fs.readFileSync(srtFilePath, 'utf-8');
      const segments = this.parseSrt(srtContent);

      if (segments.length === 0) {
        throw new BadRequestException('SRT file contains no segments.');
      }

      this.logger.log(
        `📄 Parsed ${segments.length} segments from SRT`,
      );

      // 2. TTS each segment
      const segmentResults: SegmentResult[] = [];

      for (const segment of segments) {
        this.logger.log(
          `🎤 TTS segment ${segment.id}/${segments.length}: "${segment.text.substring(0, 50)}..."`,
        );

        // 2a. Call XTTS server for this segment
        const ttsAudioPath = path.join(
          workDir,
          `tts_${segment.id}.wav`,
        );
        await this.callTts(
          segment.text,
          language,
          speaker,
          voiceId,
          ttsAudioPath,
        );

        // 2b. Measure TTS audio duration
        const ttsDurationMs = await this.getAudioDurationMs(ttsAudioPath);

        // 2c. Calculate tempo ratio and stretch
        const srtDurationMs = segment.durationMs;
        let tempoRatio = ttsDurationMs / srtDurationMs;

        // Clamp to reasonable range (0.25x to 4x)
        tempoRatio = Math.max(0.25, Math.min(4.0, tempoRatio));

        this.logger.log(
          `  ⏱ SRT: ${srtDurationMs}ms | TTS: ${ttsDurationMs}ms | Tempo: ${tempoRatio.toFixed(3)}`,
        );

        const stretchedPath = path.join(
          workDir,
          `stretched_${segment.id}.wav`,
        );

        await this.stretchAudio(
          ttsAudioPath,
          stretchedPath,
          tempoRatio,
        );

        segmentResults.push({
          segmentId: segment.id,
          text: segment.text,
          srtStartMs: segment.startMs,
          srtEndMs: segment.endMs,
          srtDurationMs,
          ttsDurationMs,
          tempoRatio,
          stretchedPath,
        });
      }

      // 3. Build timeline: insert silences between segments
      this.logger.log('🔗 Building final timeline...');
      const timelineParts: string[] = [];

      for (let i = 0; i < segmentResults.length; i++) {
        const seg = segmentResults[i];

        // Calculate silence before this segment
        const prevEndMs =
          i === 0 ? 0 : segmentResults[i - 1].srtEndMs;
        const silenceDurationMs = seg.srtStartMs - prevEndMs;

        if (silenceDurationMs > 10) {
          // Generate silence (skip tiny gaps < 10ms)
          const silencePath = path.join(
            workDir,
            `silence_${i}.wav`,
          );
          await this.generateSilence(
            silencePath,
            silenceDurationMs / 1000,
          );
          timelineParts.push(silencePath);
        }

        timelineParts.push(seg.stretchedPath);
      }

      // 4. Concatenate all parts
      const outputFilename = `tts_srt_${Date.now()}.${outputFormat}`;
      const outputPath = path.join(workDir, outputFilename);

      await this.concatenateAudio(timelineParts, outputPath, outputFormat);

      this.logger.log(
        `✅ Final audio created: ${outputFilename}`,
      );

      // 5. Cleanup SRT file
      if (fs.existsSync(srtFilePath)) {
        fs.unlinkSync(srtFilePath);
      }

      return {
        outputPath,
        outputFilename,
        segments: segmentResults.map((s) => ({
          ...s,
          stretchedPath: undefined, // Don't expose internal paths
        })) as any,
      };
    } catch (error) {
      // Cleanup on error
      if (fs.existsSync(srtFilePath)) {
        fs.unlinkSync(srtFilePath);
      }
      this.cleanupDir(workDir);
      throw error;
    }
  }

  // ─────────────────────────────────────────────
  // SRT Parsing
  // ─────────────────────────────────────────────

  private parseSrt(content: string): SrtSegment[] {
    const segments: SrtSegment[] = [];
    // Normalize line endings
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalized.split(/\n\n+/).filter((b) => b.trim());

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 3) continue;

      const id = parseInt(lines[0].trim(), 10);
      if (isNaN(id)) continue;

      const timeLine = lines[1].trim();
      const timeMatch = timeLine.match(
        /(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/,
      );
      if (!timeMatch) continue;

      const startTime = timeMatch[1];
      const endTime = timeMatch[2];
      const text = lines
        .slice(2)
        .join(' ')
        .replace(/<[^>]*>/g, '') // Strip HTML tags
        .trim();

      if (!text) continue;

      const startMs = this.srtTimeToMs(startTime);
      const endMs = this.srtTimeToMs(endTime);

      segments.push({
        id,
        startTime,
        endTime,
        text,
        startMs,
        endMs,
        durationMs: endMs - startMs,
      });
    }

    return segments;
  }

  private srtTimeToMs(time: string): number {
    // "00:01:23,456" or "00:01:23.456" → milliseconds
    const parts = time.replace(',', '.').split(':');
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const secParts = parts[2].split('.');
    const seconds = parseInt(secParts[0], 10);
    const ms = parseInt(secParts[1], 10);
    return hours * 3600000 + minutes * 60000 + seconds * 1000 + ms;
  }

  // ─────────────────────────────────────────────
  // XTTS Server Communication
  // ─────────────────────────────────────────────

  private async callTts(
    text: string,
    language: string,
    speaker: string | undefined,
    voiceId: string | undefined,
    outputPath: string,
  ): Promise<void> {
    const form = new FormData();
    form.append('text', text);
    form.append('language', language);

    if (voiceId) {
      form.append('voice_id', voiceId);
    } else if (speaker) {
      form.append('speaker', speaker);
    } else {
      throw new BadRequestException(
        'Either speaker or voice_id must be provided.',
      );
    }

    try {
      const response = await axios.post(
        `${this.xttsBaseUrl}/tts`,
        form,
        {
          headers: form.getHeaders(),
          responseType: 'arraybuffer',
          timeout: 120000, // 2 min timeout per segment
        },
      );

      fs.writeFileSync(outputPath, Buffer.from(response.data));
    } catch (error) {
      const message =
        error?.response?.data
          ? Buffer.from(error.response.data).toString('utf-8')
          : error?.message || 'Unknown error';
      throw new BadRequestException(
        `TTS failed for text "${text.substring(0, 30)}...": ${message}`,
      );
    }
  }

  // ─────────────────────────────────────────────
  // FFmpeg Audio Processing
  // ─────────────────────────────────────────────

  /**
   * Get audio duration in milliseconds using ffprobe.
   */
  private getAudioDurationMs(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      Ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          reject(
            new BadRequestException(
              `Failed to probe audio: ${err.message}`,
            ),
          );
          return;
        }
        const durationSec = metadata.format.duration || 0;
        resolve(Math.round(durationSec * 1000));
      });
    });
  }

  /**
   * Stretch or compress audio using ffmpeg atempo filter.
   * tempoRatio > 1 = speed up (TTS is longer than SRT, need to compress)
   * tempoRatio < 1 = slow down (TTS is shorter than SRT, need to stretch)
   *
   * atempo filter supports range [0.5, 100.0].
   * For values < 0.5, chain multiple atempo filters.
   */
  private stretchAudio(
    inputPath: string,
    outputPath: string,
    tempoRatio: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // If ratio is very close to 1.0, just copy
      if (Math.abs(tempoRatio - 1.0) < 0.02) {
        fs.copyFileSync(inputPath, outputPath);
        resolve();
        return;
      }

      // Build atempo filter chain
      const atempoFilters = this.buildAtempoFilters(tempoRatio);

      const command = Ffmpeg(inputPath)
        .audioFilters(atempoFilters)
        .audioCodec('pcm_s16le')
        .audioChannels(1)
        .audioFrequency(24000)
        .output(outputPath);

      command
        .on('end', () => resolve())
        .on('error', (err: Error) => {
          reject(
            new BadRequestException(
              `Audio stretching failed: ${err.message}`,
            ),
          );
        })
        .run();
    });
  }

  /**
   * Build atempo filter chain.
   * atempo supports [0.5, 100.0] per filter instance.
   * For ratios < 0.5, chain multiple atempo=0.5 filters + remainder.
   * For ratios > 100, chain multiple atempo=100 filters + remainder.
   */
  private buildAtempoFilters(ratio: number): string[] {
    const filters: string[] = [];

    if (ratio < 0.5) {
      // Chain multiple atempo=0.5 until remaining ratio >= 0.5
      let remaining = ratio;
      while (remaining < 0.5) {
        filters.push('atempo=0.5');
        remaining /= 0.5;
      }
      filters.push(`atempo=${remaining.toFixed(4)}`);
    } else if (ratio > 100.0) {
      let remaining = ratio;
      while (remaining > 100.0) {
        filters.push('atempo=100.0');
        remaining /= 100.0;
      }
      filters.push(`atempo=${remaining.toFixed(4)}`);
    } else {
      filters.push(`atempo=${ratio.toFixed(4)}`);
    }

    return filters;
  }

  /**
   * Generate a silence WAV file with the given duration.
   */
  private generateSilence(
    outputPath: string,
    durationSec: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      Ffmpeg()
        .input('anullsrc=r=24000:cl=mono')
        .inputFormat('lavfi')
        .duration(durationSec)
        .audioCodec('pcm_s16le')
        .audioChannels(1)
        .audioFrequency(24000)
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => {
          reject(
            new BadRequestException(
              `Silence generation failed: ${err.message}`,
            ),
          );
        })
        .run();
    });
  }

  /**
   * Concatenate multiple audio files into a single output file.
   * Uses ffmpeg concat demuxer for seamless joining.
   */
  private concatenateAudio(
    inputPaths: string[],
    outputPath: string,
    format: string = 'wav',
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (inputPaths.length === 0) {
        reject(new BadRequestException('No audio files to concatenate.'));
        return;
      }

      if (inputPaths.length === 1) {
        fs.copyFileSync(inputPaths[0], outputPath);
        resolve();
        return;
      }

      // Create a concat list file
      const listPath = outputPath + '.list.txt';
      const listContent = inputPaths
        .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
        .join('\n');
      fs.writeFileSync(listPath, listContent);

      const command = Ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .audioChannels(1)
        .audioFrequency(24000);

      if (format === 'mp3') {
        command.audioCodec('libmp3lame').audioBitrate('192k');
      } else {
        command.audioCodec('pcm_s16le');
      }

      command
        .output(outputPath)
        .on('end', () => {
          // Cleanup list file
          fs.unlinkSync(listPath);
          resolve();
        })
        .on('error', (err: Error) => {
          if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
          reject(
            new BadRequestException(
              `Audio concatenation failed: ${err.message}`,
            ),
          );
        })
        .run();
    });
  }

  /**
   * Cleanup a temporary directory.
   */
  cleanupDir(dirPath: string): void {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
    } catch {
      this.logger.warn(`Failed to cleanup directory: ${dirPath}`);
    }
  }
}

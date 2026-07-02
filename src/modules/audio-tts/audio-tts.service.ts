import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import SrtParser2 from 'srt-parser-2';

import {
  VIENEU_DEFAULT_VOICES,
  VieneuVoice,
} from './constants/voices.constant';

// ──────────────────────────────────────────────────────────────────────────────
// Set FFmpeg binary path from the bundled installer
// ──────────────────────────────────────────────────────────────────────────────
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/** Represents one parsed SRT line from srt-parser-2 */
interface SrtLine {
  id: string;
  startTime: string;
  startSeconds: number;
  endTime: string;
  endSeconds: number;
  text: string;
}

@Injectable()
export class AudioTtsService implements OnModuleInit {
  private readonly logger = new Logger(AudioTtsService.name);

  /** VieNeu-TTS local server base URL */
  private vieneuServerUrl: string;

  /** Cached voices list from VieNeu-TTS server */
  private cachedVoices: VieneuVoice[] | null = null;

  /** Retry configuration for transient errors */
  private readonly MAX_RETRIES = 5;
  private readonly BASE_DELAY_MS = 2000;

  /**
   * Max characters per TTS chunk. VieNeu-TTS can handle long text,
   * but we split into chunks for stability with very long content.
   */
  private readonly MAX_CHARS_PER_CHUNK = 2000;

  /** Delay between chunk requests (ms) to avoid overloading the local server */
  private readonly CHUNK_DELAY_MS = 500;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.vieneuServerUrl =
      this.configService.get<string>('VIENEU_SERVER_URL') ||
      'http://localhost:8020';

    this.logger.log(
      `VieNeu-TTS server URL: ${this.vieneuServerUrl}`,
    );

    // Attempt to fetch voices from the server (non-blocking)
    this.fetchVoicesFromServer().catch(() => {
      this.logger.warn(
        'Could not fetch voices from VieNeu-TTS server. Using default fallback list.',
      );
    });
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Return the list of available VieNeu-TTS voices.
   */
  getAvailableVoices(): VieneuVoice[] {
    return this.cachedVoices || VIENEU_DEFAULT_VOICES;
  }

  /**
   * Smart TTS pipeline using VieNeu-TTS local server:
   *   1. Parse SRT → extract all subtitle text
   *   2. If text is short enough → 1 single API call
   *   3. If text is too long  → split into smart chunks, 1 call per chunk
   *   4. Merge audio chunks + convert to MP3
   *
   * @param srtContent    Raw SRT file content (UTF-8 string)
   * @param selectedVoice Voice name (e.g. 'Bình An')
   * @param outputMp3Path Absolute path where the final MP3 will be written
   */
  async generateAudioFromSrt(
    srtContent: string,
    selectedVoice: string,
    outputMp3Path: string,
  ): Promise<void> {
    // 1. Parse the SRT content
    const parser = new SrtParser2();
    const lines: SrtLine[] = parser.fromSrt(srtContent);

    if (!lines || lines.length === 0) {
      throw new BadRequestException(
        'No valid subtitle lines found in the uploaded SRT file.',
      );
    }

    this.logger.log(
      `Starting SRT TTS pipeline on Python server: ${lines.length} lines, voice="${selectedVoice}"`,
    );

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-srt-'));
    const tempWavPath = path.join(tempDir, 'output.wav');

    try {
      const url = `${this.vieneuServerUrl}/tts/generate-from-srt`;

      let response: import('axios').AxiosResponse<ArrayBuffer>;
      try {
        const axios = await import('axios');
        response = await axios.default.post<ArrayBuffer>(
          url,
          {
            srt: srtContent,
            voice: selectedVoice,
          },
          {
            headers: { 'Content-Type': 'application/json' },
            responseType: 'arraybuffer',
            timeout: 18000000, // 30 minutes
          },
        );
      } catch (err: unknown) {
        const axiosError = err as { response?: { status: number; data: ArrayBuffer } };
        if (axiosError.response && axiosError.response.data) {
          const errorText = Buffer.from(axiosError.response.data).toString('utf-8');
          throw new Error(
            `VieNeu-TTS server returned ${axiosError.response.status}: ${errorText}`,
          );
        }
        throw err;
      }

      const audioBuffer = Buffer.from(response.data);

      if (audioBuffer.length === 0) {
        throw new Error('VieNeu-TTS returned empty audio data.');
      }

      fs.writeFileSync(tempWavPath, audioBuffer);

      this.logger.debug('Converting output WAV to MP3...');
      await this.convertWavToMp3(tempWavPath, outputMp3Path);

      this.logger.log(
        `SRT TTS completed successfully → ${outputMp3Path}`,
      );
    } catch (error) {
      const message = this.extractErrorDetail(error);
      this.logger.error(`SRT TTS generation failed: ${message}`);
      throw new InternalServerErrorException(
        `SRT TTS generation failed: ${message}`,
      );
    } finally {
      this.cleanupTempDir(tempDir);
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Fetch available voices from the VieNeu-TTS server.
   */
  private async fetchVoicesFromServer(): Promise<void> {
    const url = `${this.vieneuServerUrl}/voices`;
    this.logger.debug(`Fetching voices from ${url}...`);

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`VieNeu-TTS server returned ${response.status}`);
    }

    const data = (await response.json()) as { voices?: VieneuVoice[] };
    if (data.voices && Array.isArray(data.voices)) {
      this.cachedVoices = data.voices;
      this.logger.log(
        `Fetched ${data.voices.length} voices from VieNeu-TTS server.`,
      );
    }
  }

  /**
   * Build a single text block from all SRT subtitle lines.
   * Paragraph breaks create natural TTS pauses.
   */
  private buildCombinedText(lines: SrtLine[]): string {
    const parts: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const text = line.text.replace(/\n/g, ' ').trim();
      if (!text) continue;

      // Extra break for large timing gaps (> 2s)
      if (i > 0) {
        const gap = line.startSeconds - lines[i - 1].endSeconds;
        if (gap > 2.0) {
          parts.push('');
        }
      }

      parts.push(text);
    }

    return parts.join('\n\n');
  }

  /**
   * Split combined text into chunks that respect the max char limit.
   * Splits on paragraph boundaries (\n\n) to avoid cutting mid-sentence.
   */
  private splitTextIntoChunks(text: string): string[] {
    // If short enough, return as single chunk
    if (text.length <= this.MAX_CHARS_PER_CHUNK) {
      return [text];
    }

    const paragraphs = text.split('\n\n');
    const chunks: string[] = [];
    let currentChunk = '';

    for (const paragraph of paragraphs) {
      const candidate = currentChunk
        ? currentChunk + '\n\n' + paragraph
        : paragraph;

      if (candidate.length > this.MAX_CHARS_PER_CHUNK && currentChunk) {
        // Current chunk is full — push it and start a new one
        chunks.push(currentChunk.trim());
        currentChunk = paragraph;
      } else {
        currentChunk = candidate;
      }
    }

    // Push the last chunk
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  // ─── VieNeu-TTS API call ──────────────────────────────────────────────

  /**
   * Call VieNeu-TTS with exponential-backoff retry.
   */
  private async callVieneuTtsWithRetry(
    text: string,
    voiceName: string,
    outputPath: string,
    chunkIndex: number,
    totalChunks: number,
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        await this.callVieneuTts(text, voiceName, outputPath);
        return;
      } catch (error: unknown) {
        lastError = error;

        const errorDetail = this.extractErrorDetail(error);
        this.logger.error(
          `TTS chunk ${chunkIndex}/${totalChunks} attempt ${attempt}/${this.MAX_RETRIES} error: ${errorDetail}`,
        );

        if (!this.isRetryableError(error)) {
          this.logger.error('Error is NOT retryable — failing immediately.');
          break;
        }

        if (attempt === this.MAX_RETRIES) {
          this.logger.error(
            `TTS chunk ${chunkIndex}/${totalChunks} failed after ${this.MAX_RETRIES} attempts.`,
          );
          break;
        }

        const delayMs = this.BASE_DELAY_MS * Math.pow(2, attempt - 1);
        this.logger.warn(`Retrying in ${delayMs}ms...`);
        await this.delay(delayMs);
      }
    }

    const message = this.extractErrorDetail(lastError);
    throw new InternalServerErrorException(
      `TTS generation failed: ${message}`,
    );
  }

  /**
   * Single VieNeu-TTS API call. Sends text to the local server and saves
   * the returned WAV audio to disk.
   */
  private async callVieneuTts(
    text: string,
    voiceName: string,
    outputPath: string,
  ): Promise<void> {
    const url = `${this.vieneuServerUrl}/tts/generate`;

    this.logger.debug(
      `Calling VieNeu-TTS: voice="${voiceName}", text=${text.length} chars`,
    );

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: voiceName,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `VieNeu-TTS server returned ${response.status}: ${errorText}`,
      );
    }

    // Write the WAV response body to disk
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    if (audioBuffer.length === 0) {
      throw new Error('VieNeu-TTS returned empty audio data.');
    }

    fs.writeFileSync(outputPath, audioBuffer);

    this.logger.debug(
      `Received audio: ${(audioBuffer.length / 1024).toFixed(1)} KB`,
    );
  }

  // ─── FFmpeg helpers ────────────────────────────────────────────────────

  /**
   * Convert WAV audio to MP3.
   */
  private convertWavToMp3(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(inputPath)
        .audioCodec('libmp3lame')
        .audioBitrate('192k')
        .save(outputPath)
        .on('end', () => {
          this.logger.debug('MP3 conversion completed.');
          resolve();
        })
        .on('error', (err: Error) => {
          this.logger.error(`MP3 conversion failed: ${err.message}`);
          reject(
            new InternalServerErrorException(
              `Failed to convert audio to MP3: ${err.message}`,
            ),
          );
        });
    });
  }

  /**
   * Concatenate multiple WAV audio chunks and convert to MP3.
   */
  private concatWavAndConvertToMp3(
    inputPaths: string[],
    outputPath: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const command = ffmpeg();

      inputPaths.forEach((p) => {
        command.input(p);
      });

      command.complexFilter([
        {
          filter: 'concat',
          options: {
            n: inputPaths.length,
            v: 0,
            a: 1,
          },
          inputs: inputPaths.map((_, idx) => `${idx}:a`),
          outputs: 'outa',
        },
      ]);

      command
        .map('outa')
        .audioCodec('libmp3lame')
        .audioBitrate('192k')
        .save(outputPath)
        .on('end', () => {
          this.logger.debug('Audio concat and MP3 conversion completed.');
          resolve();
        })
        .on('error', (err: Error) => {
          this.logger.error(
            `Audio concat and MP3 conversion failed: ${err.message}`,
          );
          reject(
            new InternalServerErrorException(
              `Failed to merge and convert audio chunks: ${err.message}`,
            ),
          );
        });
    });
  }

  // ─── Cleanup & utilities ──────────────────────────────────────────────

  /**
   * Recursively delete a temporary directory and all its contents.
   */
  private cleanupTempDir(dirPath: string): void {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        this.logger.debug(`Cleaned up temp directory: ${dirPath}`);
      }
    } catch (error) {
      this.logger.warn(`Failed to cleanup temp dir ${dirPath}: ${error}`);
    }
  }

  /**
   * Extract detailed error info for logging.
   */
  private extractErrorDetail(error: unknown): string {
    if (error instanceof Error) {
      const cause = (error as { cause?: Error }).cause;
      if (cause) {
        return `${error.message} → Cause: ${cause.message}`;
      }
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  /**
   * Check if an error is retryable (transient errors).
   */
  private isRetryableError(error: unknown): boolean {
    const errorStr = this.extractErrorDetail(error);

    const retryablePatterns = [
      '500', // Internal Server Error
      '502', // Bad Gateway
      '503', // Service Unavailable
      '504', // Gateway Timeout
      '429', // Too Many Requests
      'fetch failed', // network / DNS / timeout
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'socket hang up',
      'network',
      'timeout',
    ];
    return retryablePatterns.some((pattern) =>
      errorStr.toLowerCase().includes(pattern.toLowerCase()),
    );
  }

  /**
   * Wait for a given number of milliseconds.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

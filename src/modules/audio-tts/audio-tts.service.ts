import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import SrtParser2 from 'srt-parser-2';

import {
  GEMINI_VOICES,
  GeminiVoice,
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

  /** Default GenAI client from .env — may be null */
  private defaultGenAI: GoogleGenAI | null = null;

  private readonly TTS_MODEL = 'gemini-2.5-flash-preview-tts';

  /** Retry configuration for transient Gemini API errors */
  private readonly MAX_RETRIES = 5;
  private readonly BASE_DELAY_MS = 2000;

  /**
   * Max characters per TTS chunk. Gemini TTS has input limits, and very long
   * text can cause timeouts or 500 internal errors on Google's side.
   * We split into smaller chunks (1500 chars) for stability and speed.
   */
  private readonly MAX_CHARS_PER_CHUNK = 1500;

  /** Delay between chunk requests (ms) to avoid rate limiting */
  private readonly CHUNK_DELAY_MS = 3000;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (apiKey) {
      this.defaultGenAI = new GoogleGenAI({ apiKey });
      this.logger.log('Default GoogleGenAI client initialized for TTS.');
    } else {
      this.logger.warn(
        'No GEMINI_API_KEY in .env — API key must be provided per-request.',
      );
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Return the list of available Gemini TTS voices.
   */
  getAvailableVoices(): GeminiVoice[] {
    return GEMINI_VOICES;
  }

  /**
   * Smart TTS pipeline:
   *   1. Parse SRT → extract all subtitle text
   *   2. If text is short enough → 1 single API call
   *   3. If text is too long  → split into smart chunks, 1 call per chunk
   *   4. Merge audio chunks + convert to MP3
   *
   * @param srtContent    Raw SRT file content (UTF-8 string)
   * @param selectedVoice Voice name (e.g. 'Kore')
   * @param outputMp3Path Absolute path where the final MP3 will be written
   * @param modelName     Optional TTS model name (defaults to gemini-2.5-flash-preview-tts)
   * @param apiKey        Optional per-request Gemini API key
   */
  async generateAudioFromSrt(
    srtContent: string,
    selectedVoice: string,
    outputMp3Path: string,
    modelName?: string,
    apiKey?: string,
  ): Promise<void> {
    // 1. Validate the chosen voice
    const voice = GEMINI_VOICES.find(
      (v) => v.id.toLowerCase() === selectedVoice.toLowerCase(),
    );
    if (!voice) {
      const valid = GEMINI_VOICES.map((v) => v.id).join(', ');
      throw new BadRequestException(
        `Voice "${selectedVoice}" is not supported. Available voices: ${valid}`,
      );
    }

    // 2. Parse the SRT content
    const parser = new SrtParser2();
    const lines: SrtLine[] = parser.fromSrt(srtContent);

    if (!lines || lines.length === 0) {
      throw new BadRequestException(
        'No valid subtitle lines found in the uploaded SRT file.',
      );
    }

    const model = modelName || this.TTS_MODEL;

    // 3. Build combined text from subtitle lines
    const combinedText = this.buildCombinedText(lines);

    this.logger.log(
      `TTS pipeline: ${lines.length} lines, ${combinedText.length} chars, voice="${voice.id}", model="${model}"`,
    );

    // 4. Split into chunks if text is too long
    const textChunks = this.splitTextIntoChunks(combinedText);

    this.logger.log(
      `Split into ${textChunks.length} chunk(s) — will use ${textChunks.length} API request(s)`,
    );

    const client = this.getClient(apiKey);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));

    try {
      const audioChunkPaths: string[] = [];

      for (let i = 0; i < textChunks.length; i++) {
        const chunk = textChunks[i];

        this.logger.debug(
          `Processing chunk ${i + 1}/${textChunks.length}: ${chunk.length} chars`,
        );

        // Rate limit delay between chunks (skip first)
        if (i > 0) {
          this.logger.debug(
            `Waiting ${this.CHUNK_DELAY_MS}ms before next chunk...`,
          );
          await this.delay(this.CHUNK_DELAY_MS);
        }

        const chunkAudioPath = path.join(tempDir, `chunk_${i}.wav`);

        await this.callGeminiTtsWithRetry(
          client,
          chunk,
          voice.id,
          chunkAudioPath,
          model,
          i + 1,
          textChunks.length,
        );

        audioChunkPaths.push(chunkAudioPath);
      }

      // 5. If single chunk → direct convert. If multiple → concat and convert.
      if (audioChunkPaths.length === 1) {
        this.logger.debug('Single chunk — converting directly to MP3...');
        await this.convertToMp3(audioChunkPaths[0], outputMp3Path);
      } else {
        this.logger.debug(
          `Merging and converting ${audioChunkPaths.length} audio chunks directly to MP3...`,
        );
        await this.concatAndConvertToMp3(audioChunkPaths, outputMp3Path);
      }

      this.logger.log(
        `TTS completed (${textChunks.length} request(s)) → ${outputMp3Path}`,
      );
    } finally {
      this.cleanupTempDir(tempDir);
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Resolve the GoogleGenAI client. Per-request key takes priority.
   */
  private getClient(apiKey?: string): GoogleGenAI {
    if (apiKey) {
      return new GoogleGenAI({ apiKey });
    }
    if (this.defaultGenAI) {
      return this.defaultGenAI;
    }
    throw new BadRequestException(
      'No API key provided. Pass "apiKey" in the request or configure GEMINI_API_KEY in .env.',
    );
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

  // ─── Gemini TTS call ───────────────────────────────────────────────────

  /**
   * Call Gemini TTS with exponential-backoff retry.
   */
  private async callGeminiTtsWithRetry(
    client: GoogleGenAI,
    text: string,
    voiceName: string,
    outputPath: string,
    model: string,
    chunkIndex: number,
    totalChunks: number,
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        await this.callGeminiTts(client, text, voiceName, outputPath, model);
        return;
      } catch (error: unknown) {
        lastError = error;

        // Log full error details for debugging
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

        let delayMs = this.BASE_DELAY_MS * Math.pow(2, attempt - 1);
        const serverRetryDelaySec = this.extractRetryDelaySeconds(error);
        if (serverRetryDelaySec !== null) {
          delayMs = Math.ceil(serverRetryDelaySec * 1000) + 1000; // Add 1s safety buffer
          this.logger.warn(
            `Server requested retry delay. Waiting ${serverRetryDelaySec}s (+1s safety buffer, total ${delayMs}ms)...`,
          );
        } else {
          this.logger.warn(
            `Retrying in ${delayMs}ms...`,
          );
        }
        await this.delay(delayMs);
      }
    }

    const message = this.extractErrorDetail(lastError);
    throw new InternalServerErrorException(
      `TTS generation failed: ${message}`,
    );
  }

  /**
   * Single Gemini TTS API call. Saves the returned audio buffer to disk.
   */
  private async callGeminiTts(
    client: GoogleGenAI,
    text: string,
    voiceName: string,
    outputPath: string,
    model: string,
  ): Promise<void> {
    this.logger.debug(
      `Calling Gemini TTS: model="${model}", voice="${voiceName}", text=${text.length} chars`,
    );

    const response = await client.models.generateContent({
      model,
      contents: text,
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName,
            },
          },
        },
      },
    });

    // Extract inline audio data from the response
    const part = response.candidates?.[0]?.content?.parts?.[0];
    if (!part || !part.inlineData?.data) {
      // Log what we actually got back for debugging
      this.logger.error(
        `Gemini TTS response structure: ${JSON.stringify({
          hasCandidates: !!response.candidates,
          candidateCount: response.candidates?.length ?? 0,
          hasParts: !!response.candidates?.[0]?.content?.parts,
          partCount: response.candidates?.[0]?.content?.parts?.length ?? 0,
        })}`,
      );
      throw new Error('Gemini TTS returned no audio data.');
    }

    const audioBuffer = Buffer.from(part.inlineData.data, 'base64');
    fs.writeFileSync(outputPath, audioBuffer);

    this.logger.debug(
      `Received audio: ${(audioBuffer.length / 1024).toFixed(1)} KB`,
    );
  }

  // ─── FFmpeg helpers ────────────────────────────────────────────────────

  /**
   * Convert raw audio (WAV/PCM from Gemini) to MP3.
   */
  private convertToMp3(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(inputPath)
        .inputOptions(['-f', 's16le', '-ar', '24000', '-ac', '1'])
        .audioCodec('libmp3lame')
        .audioBitrate('192k')
        .outputOptions('-ar', '24000')
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
   * Concatenate multiple audio chunks and convert to MP3 directly using complex filter.
   * This bypasses the demuxer, avoids any safe path limitations, and is extremely resilient.
   */
  private concatAndConvertToMp3(
    inputPaths: string[],
    outputPath: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const command = ffmpeg();
      inputPaths.forEach((p) => {
        command.input(p).inputOptions(['-f', 's16le', '-ar', '24000', '-ac', '1']);
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
        .outputOptions('-ar', '24000')
        .save(outputPath)
        .on('end', () => {
          this.logger.debug('Audio concat and MP3 conversion completed.');
          resolve();
        })
        .on('error', (err: Error) => {
          this.logger.error(`Audio concat and MP3 conversion failed: ${err.message}`);
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
      // Check for nested cause (Node.js fetch errors)
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
   * Extract retryDelay seconds from Google GenAI API error response if available.
   */
  private extractRetryDelaySeconds(error: unknown): number | null {
    try {
      let errObj: any = null;
      if (typeof error === 'object' && error !== null) {
        errObj = error;
      }
      if (error instanceof Error) {
        try {
          errObj = JSON.parse(error.message);
        } catch {
          if ((error as any).error) {
            errObj = (error as any).error;
          }
        }
      }

      if (!errObj) return null;

      const apiErr = errObj.error || errObj;
      if (apiErr && Array.isArray(apiErr.details)) {
        for (const detail of apiErr.details) {
          if (
            detail &&
            (detail['@type']?.includes('RetryInfo') || detail.retryDelay)
          ) {
            const delayStr = detail.retryDelay;
            if (typeof delayStr === 'string') {
              const seconds = parseFloat(delayStr.replace('s', ''));
              if (!isNaN(seconds)) {
                return seconds;
              }
            }
          }
        }
      }
    } catch (e) {
      this.logger.debug(`Failed to parse retry delay from error: ${e}`);
    }
    return null;
  }

  /**
   * Check if an error is retryable (transient API / network errors).
   */
  private isRetryableError(error: unknown): boolean {
    const errorStr = this.extractErrorDetail(error);

    // If quota limit is explicitly 0, it means the model is not allowed/enabled on this tier.
    // Retrying is futile, so fail immediately.
    if (errorStr.includes('limit: 0') || errorStr.includes('limit:0')) {
      return false;
    }

    const retryablePatterns = [
      '500',                   // Internal Server Error
      '502',                   // Bad Gateway
      '503',                   // Service Unavailable
      '504',                   // Gateway Timeout
      '429',                   // Too Many Requests
      'INTERNAL',              // Google RPC internal status
      'UNAVAILABLE',
      'RESOURCE_EXHAUSTED',
      'fetch failed',          // network / DNS / timeout
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'socket hang up',
      'network',
      'timeout',
      'bad_gateway',
      'gateway_timeout',
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

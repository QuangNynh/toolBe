import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import pLimit from 'p-limit';

const execAsync = promisify(exec);

@Injectable()
export class TtsService implements OnModuleInit {
  private readonly logger = new Logger(TtsService.name);
  private readonly limit = pLimit(5); // Increased to 5 concurrent chunks
  private pythonProcess: any = null;
  private isModelWarmedUp = false;

  onModuleInit() {
    // Warm up model on startup (fire and forget)
    this.warmUpModel().catch((err) => {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      this.logger.warn(`Model warm-up failed: ${errorMessage}`);
    });
  }

  private async warmUpModel(): Promise<void> {
    if (this.isModelWarmedUp) return;

    this.logger.log('Warming up Coqui VITS model...');
    const scriptPath = path.join(process.cwd(), 'src/python/tts_vits.py');
    const venvPath = path.join(process.cwd(), 'venv');
    const tempFile = path.join(os.tmpdir(), 'warmup.wav');

    try {
      await execAsync(
        `source ${venvPath}/bin/activate && python3 ${scriptPath} "Hello world" "${tempFile}"`,
        {
          shell: '/bin/bash',
          timeout: 60000, // Increased timeout for first load
        },
      );

      // Clean up
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }

      this.isModelWarmedUp = true;
      this.logger.log('Coqui VITS model warmed up successfully');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Model warm-up failed: ${errorMessage}`);
    }
  }

  private splitTextIntoChunks(text: string, maxLength = 400): string[] {
    // Optimized text splitting with better sentence detection
    const sentences = text.split(/(?<=[.!?])\s+/);
    const chunks: string[] = [];
    let currentChunk = '';

    for (const sentence of sentences) {
      if (sentence.length > maxLength) {
        // Split long sentences by commas first, then words
        const parts = sentence.split(/,\s+/);

        for (const part of parts) {
          if (part.length > maxLength) {
            const words = part.split(' ');
            let tempChunk = '';

            for (const word of words) {
              if (tempChunk.length + word.length + 1 <= maxLength) {
                tempChunk += word + ' ';
              } else {
                if (tempChunk) {
                  chunks.push(tempChunk.trim());
                }
                tempChunk = word + ' ';
              }
            }
            if (tempChunk) {
              chunks.push(tempChunk.trim());
            }
          } else if (currentChunk.length + part.length + 1 <= maxLength) {
            currentChunk += part + ', ';
          } else {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
            }
            currentChunk = part + ', ';
          }
        }
      } else if (currentChunk.length + sentence.length + 1 <= maxLength) {
        currentChunk += sentence + ' ';
      } else {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }
        currentChunk = sentence + ' ';
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }

    return chunks.filter((chunk) => chunk.length > 0);
  }

  private async generateChunk(
    chunkText: string,
    chunkIndex: number,
    tempDir: string,
  ): Promise<string> {
    const scriptPath = path.join(process.cwd(), 'src/python/tts_vits.py');
    const venvPath = path.join(process.cwd(), 'venv');
    const outputFile = path.join(
      tempDir,
      `chunk_${String(chunkIndex).padStart(4, '0')}.wav`,
    );

    // Optimized escaping
    const escapedText = chunkText
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/'/g, "\\'")
      .replace(/\n/g, ' ');

    try {
      await execAsync(
        `source ${venvPath}/bin/activate && python3 ${scriptPath} "${escapedText}" "${outputFile}"`,
        {
          shell: '/bin/bash',
          cwd: process.cwd(),
          maxBuffer: 10 * 1024 * 1024,
          timeout: 60000, // 60s timeout per chunk
        },
      );

      return outputFile;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Chunk ${chunkIndex + 1} failed: ${errorMessage}`);
      throw error;
    }
  }

  private async mergeAudioFiles(
    audioFiles: string[],
    outputFile: string,
  ): Promise<void> {
    const listFile = path.join(path.dirname(audioFiles[0]), 'filelist.txt');

    // Create file list for ffmpeg
    const fileListContent = audioFiles
      .map((file) => `file '${file}'`)
      .join('\n');
    fs.writeFileSync(listFile, fileListContent);

    this.logger.log(`Merging ${audioFiles.length} audio files with ffmpeg...`);

    try {
      // Optimized ffmpeg command with faster settings
      await execAsync(
        `ffmpeg -f concat -safe 0 -i "${listFile}" -filter_complex "[0:a]apad=pad_dur=0.15[a]" -map "[a]" -c:a pcm_s16le -ar 16000 -ac 1 -y "${outputFile}"`,
        {
          maxBuffer: 100 * 1024 * 1024, // Increased buffer
          timeout: 120000, // 2 minutes timeout
        },
      );

      this.logger.log('Successfully merged audio files');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`FFmpeg merge failed: ${errorMessage}`);
      throw new Error(`Failed to merge audio files: ${errorMessage}`);
    }
  }

  async generate(text: string): Promise<Buffer> {
    const startTime = Date.now();
    this.logger.log(`Generating TTS for ${text.length} characters`);

    // Ensure model is warmed up
    if (!this.isModelWarmedUp) {
      await this.warmUpModel();
    }

    // Split text into chunks
    const chunks = this.splitTextIntoChunks(text);
    this.logger.log(`Split into ${chunks.length} chunks`);

    // Create temporary directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
    const outputFile = path.join(tempDir, 'final_output.wav');

    try {
      // Process chunks concurrently with limit
      const startProcessing = Date.now();
      const audioFiles = await Promise.all(
        chunks.map((chunk, index) =>
          this.limit(() => this.generateChunk(chunk, index, tempDir)),
        ),
      );
      const processingTime = ((Date.now() - startProcessing) / 1000).toFixed(2);
      this.logger.log(
        `Processed ${chunks.length} chunks in ${processingTime}s`,
      );

      // Merge all audio files
      const startMerge = Date.now();
      await this.mergeAudioFiles(audioFiles, outputFile);
      const mergeTime = ((Date.now() - startMerge) / 1000).toFixed(2);
      this.logger.log(`Merged audio in ${mergeTime}s`);

      // Read final output
      const buffer = fs.readFileSync(outputFile);

      const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
      const charsPerSecond = (text.length / parseFloat(totalDuration)).toFixed(
        0,
      );
      this.logger.log(
        `TTS completed in ${totalDuration}s (${buffer.length} bytes, ${charsPerSecond} chars/s)`,
      );

      return buffer;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`TTS generation failed: ${errorMessage}`);
      throw error;
    } finally {
      // Clean up temporary directory asynchronously
      setImmediate(() => {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
          const cleanupMessage =
            cleanupError instanceof Error
              ? cleanupError.message
              : 'Unknown error';
          this.logger.warn(
            `Failed to cleanup temp directory: ${cleanupMessage}`,
          );
        }
      });
    }
  }
}

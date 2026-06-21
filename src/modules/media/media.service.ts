import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as Ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Audio codec mapping for each output format */
const CODEC_MAP: Record<string, string> = {
  mp3: 'libmp3lame',
  wav: 'pcm_s16le',
  aac: 'aac',
  flac: 'flac',
  ogg: 'libvorbis',
};

/** MIME type mapping for each output format */
const MIME_MAP: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
};

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  /**
   * Extract audio from a video file using fluent-ffmpeg.
   * Returns the path to the output audio file.
   */
  async extractAudio(
    inputPath: string,
    format: string = 'mp3',
    bitrate: string = '192',
  ): Promise<{ outputPath: string; outputFilename: string }> {
    const codec = CODEC_MAP[format];
    if (!codec) {
      throw new BadRequestException(
        `Unsupported audio format: ${format}. Supported: ${Object.keys(CODEC_MAP).join(', ')}`,
      );
    }

    const tempDir = os.tmpdir();
    const baseName = `audio-${Date.now()}`;
    const outputPath = path.join(tempDir, `${baseName}.${format}`);
    const inputBasename = path.basename(
      inputPath,
      path.extname(inputPath),
    );
    const outputFilename = `${inputBasename}.${format}`;

    this.logger.log(
      `Extracting audio: ${path.basename(inputPath)} → ${format} @ ${bitrate}kbps`,
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const command = Ffmpeg(inputPath)
          .noVideo()
          .audioCodec(codec)
          .audioChannels(2);

        // WAV and FLAC don't use bitrate
        if (format !== 'wav' && format !== 'flac') {
          command.audioBitrate(`${bitrate}k`);
        }

        command
          .save(outputPath)
          .on('start', (cmd: string) => {
            this.logger.debug(`FFmpeg command: ${cmd}`);
          })
          .on('progress', (progress: { percent?: number }) => {
            if (progress.percent) {
              this.logger.debug(
                `Processing: ${Math.round(progress.percent)}%`,
              );
            }
          })
          .on('end', () => {
            this.logger.log('Audio extraction completed successfully.');
            resolve();
          })
          .on('error', (err: Error) => {
            this.logger.error(`FFmpeg error: ${err.message}`);
            reject(err);
          });
      });

      return { outputPath, outputFilename };
    } catch (error: unknown) {
      // Cleanup output if it was partially created
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }

      const message =
        error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException(
        `Audio extraction failed: ${message}`,
      );
    }
  }

  /**
   * Get the MIME type for a given audio format.
   */
  getMimeType(format: string): string {
    return MIME_MAP[format] || 'application/octet-stream';
  }
}

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as Ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { YoutubeService } from '../youtube/youtube.service';
import { TranslationService } from '../translation/translation.service';
import { AudioTtsService } from '../audio-tts/audio-tts.service';

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

  constructor(
    private readonly youtubeService: YoutubeService,
    private readonly translationService: TranslationService,
    private readonly audioTtsService: AudioTtsService,
  ) {}

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
   * Translate a video:
   * 1. Extract audio
   * 2. Speech-to-text (original SRT) using Whisper
   * 3. Translate SRT using Gemini
   * 4. Merge original and translated SRT to create a dual subtitle file
   * 5. Generate TTS audio (MP3) from translated SRT
   * 6. Merge the TTS audio and dual subtitles into the original video using FFmpeg
   */
  async translateVideo(
    videoPath: string,
    voice: string,
    apiKey?: string,
    targetLanguage: string = 'Vietnamese',
  ): Promise<{ outputPath: string; outputFilename: string }> {
    const tempDir = os.tmpdir();

    // 1. Extract audio
    this.logger.log(
      `[TranslateVideo] Step 1: Extracting audio from video: ${videoPath}`,
    );
    const { outputPath: tempAudioPath } = await this.extractAudio(
      videoPath,
      'mp3',
    );

    // 2. Generate original SRT
    this.logger.log(
      `[TranslateVideo] Step 2: Running Whisper to generate original SRT`,
    );
    let originalSrt: string;
    try {
      originalSrt = await this.youtubeService.audioToSrt(tempAudioPath);
    } catch (err) {
      // In case tempAudioPath was not cleaned up
      if (fs.existsSync(tempAudioPath)) {
        fs.unlinkSync(tempAudioPath);
      }
      throw new BadRequestException(
        `Failed to transcribe video audio: ${(err as Error).message}`,
      );
    }

    if (!originalSrt || originalSrt.trim() === '') {
      throw new BadRequestException('No speech detected in the video.');
    }

    // 3. Translate SRT
    this.logger.log(
      `[TranslateVideo] Step 3: Translating SRT to ${targetLanguage}`,
    );
    const translationResult = await this.translationService.translateSrt(
      originalSrt,
      targetLanguage,
      'gemini-2.5-flash',
      apiKey,
    );
    const translatedSrt = translationResult.translatedSrt;

    // 4. Merge original and translated SRT
    this.logger.log('[TranslateVideo] Step 4: Creating dual-language SRT');
    const dualSrt = this.mergeSrts(originalSrt, translatedSrt);
    const tempSrtPath = path.join(tempDir, `dual-${Date.now()}.srt`);
    fs.writeFileSync(tempSrtPath, dualSrt, 'utf-8');

    // 5. Generate TTS from translated SRT
    this.logger.log(
      `[TranslateVideo] Step 5: Generating TTS audio using voice: ${voice}`,
    );
    const tempTtsAudioPath = path.join(tempDir, `tts-${Date.now()}.mp3`);
    try {
      await this.audioTtsService.generateAudioFromSrt(
        translatedSrt,
        voice,
        tempTtsAudioPath,
      );
    } catch (err) {
      if (fs.existsSync(tempSrtPath)) fs.unlinkSync(tempSrtPath);
      throw new BadRequestException(
        `Failed to generate TTS: ${(err as Error).message}`,
      );
    }

    // 6. Merge the TTS audio and subtitles into the video
    this.logger.log(
      '[TranslateVideo] Step 6: Merging TTS audio and dual subtitles into video',
    );
    const inputBasename = path.basename(videoPath, path.extname(videoPath));
    const outputFilename = `${inputBasename}_translated.mp4`;
    const outputPath = path.join(tempDir, `translated-video-${Date.now()}.mp4`);

    try {
      const ffmpegInstaller = await import('@ffmpeg-installer/ffmpeg');
      const { promisify } = await import('util');
      const { exec } = await import('child_process');
      const execPromise = promisify(exec);

      // Path escaping for subtitles filter in ffmpeg
      const escapedSrtPath = tempSrtPath
        .replace(/\\/g, '/')
        .replace(/'/g, "'\\''");

      try {
        this.logger.debug(
          'Running ffmpeg command for audio replacement and hardsubbing...',
        );
        await execPromise(
          `"${ffmpegInstaller.path}" -i "${videoPath}" -i "${tempTtsAudioPath}" -map 0:v -map 1:a -c:a aac -vf "subtitles='${escapedSrtPath}'" -preset fast -y "${outputPath}"`,
          { maxBuffer: 100 * 1024 * 1024, timeout: 0 },
        );
      } catch (ffmpegErr) {
        this.logger.warn(
          `Subtitles burning failed, falling back to audio-only merge: ${(ffmpegErr as Error).message}`,
        );
        // Fallback: merge audio only
        await execPromise(
          `"${ffmpegInstaller.path}" -i "${videoPath}" -i "${tempTtsAudioPath}" -map 0:v -map 1:a -c:a aac -preset fast -y "${outputPath}"`,
          { maxBuffer: 100 * 1024 * 1024, timeout: 0 },
        );
      }
    } catch (err) {
      throw new BadRequestException(
        `Failed to compile final video: ${(err as Error).message}`,
      );
    } finally {
      // Cleanup temp files
      if (fs.existsSync(tempSrtPath)) fs.unlinkSync(tempSrtPath);
      if (fs.existsSync(tempTtsAudioPath)) fs.unlinkSync(tempTtsAudioPath);
    }

    return { outputPath, outputFilename };
  }

  private mergeSrts(originalSrt: string, translatedSrt: string): string {
    const parse = (content: string) => {
      const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const rawBlocks = normalized.split(/\n\n+/).filter((b) => b.trim());
      const blocks: { index: string; timestamp: string; text: string }[] = [];
      for (const raw of rawBlocks) {
        const lines = raw.trim().split('\n');
        if (lines.length < 3) continue;
        const index = lines[0].trim();
        const timestamp = lines[1].trim();
        const text = lines.slice(2).join('\n');
        if (!timestamp.includes('-->')) continue;
        blocks.push({ index, timestamp, text });
      }
      return blocks;
    };

    const origBlocks = parse(originalSrt);
    const transBlocks = parse(translatedSrt);

    const merged = origBlocks.map((orig, i) => {
      const trans =
        transBlocks.find((t) => t.index === orig.index) || transBlocks[i];
      const text = trans ? `${orig.text}\n${trans.text}` : orig.text;
      return `${orig.index}\n${orig.timestamp}\n${text}`;
    });

    return merged.join('\n\n');
  }

  /**
   * Get the MIME type for a given audio format.
   */
  getMimeType(format: string): string {
    return MIME_MAP[format] || 'application/octet-stream';
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { Response } from 'express';
import * as fs from 'fs';
import { MediaService } from './media.service';
import { ExtractAudioDto } from './dto/extract-audio.dto';
import { TranslateVideoDto } from './dto/translate-video.dto';

const ALLOWED_VIDEO_EXTS = [
  '.mp4',
  '.mkv',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.webm',
  '.m4v',
  '.ts',
  '.mts',
  '.3gp',
];

@ApiTags('Media')
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('extract-audio')
  @ApiOperation({
    summary: 'Extract audio track from an uploaded video file',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description:
            'Video file (mp4, mkv, avi, mov, webm, etc.)',
        },
        format: {
          type: 'string',
          description: 'Output audio format (default: mp3)',
          enum: ['mp3', 'wav', 'aac', 'flac', 'ogg'],
          default: 'mp3',
        },
        bitrate: {
          type: 'string',
          description: 'Audio bitrate in kbps (default: 192)',
          enum: ['64', '128', '192', '256', '320'],
          default: '192',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Extracted audio file download.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Bad request — missing file, unsupported format, or extraction failed.',
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads',
        filename: (_req, file, cb) => {
          const randomName = Array(32)
            .fill(null)
            .map(() => Math.round(Math.random() * 16).toString(16))
            .join('');
          // Preserve original extension for ffmpeg to detect input format
          cb(null, `${randomName}${extname(file.originalname)}`);
        },
      }),
      fileFilter: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase();
        if (!ALLOWED_VIDEO_EXTS.includes(ext)) {
          cb(
            new BadRequestException(
              `Unsupported video format: ${ext}. Allowed: ${ALLOWED_VIDEO_EXTS.join(', ')}`,
            ),
            false,
          );
          return;
        }
        cb(null, true);
      },
      limits: {
        fileSize: 500 * 1024 * 1024, // 500MB max
      },
    }),
  )
  async extractAudio(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: ExtractAudioDto,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    if (!file) {
      throw new BadRequestException('No video file uploaded.');
    }

    const format = dto.format || 'mp3';
    const bitrate = dto.bitrate || '192';

    try {
      const { outputPath, outputFilename } =
        await this.mediaService.extractAudio(file.path, format, bitrate);

      // Get file size for Content-Length header
      const stat = fs.statSync(outputPath);
      const mimeType = this.mediaService.getMimeType(format);

      // Set response headers
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', stat.size.toString());
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(outputFilename)}"`,
      );

      // Stream the audio file to the client
      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);

      // Cleanup after streaming
      res.on('finish', () => {
        // Delete output audio file
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
        // Delete uploaded video file
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });

      stream.on('error', () => {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      });
    } catch (error) {
      // Cleanup uploaded file on error
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      throw error;
    }
  }

  @Post('translate-video')
  @ApiOperation({
    summary: 'Translate video audio track and merge dual subtitles into the video',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'voice'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Video file to translate (mp4, mkv, etc.)',
        },
        voice: {
          type: 'string',
          description: 'VieNeu-TTS voice name (e.g. Bình An, Ngọc Lan, Ngọc Linh)',
          example: 'Bình An',
        },
        apiKey: {
          type: 'string',
          description: 'Gemini API key (optional — overrides default .env key)',
          example: 'AIzaSy...',
        },
        targetLanguage: {
          type: 'string',
          description: 'Target language for translation (optional, defaults to Vietnamese)',
          example: 'Vietnamese',
          default: 'Vietnamese',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Translated video file download.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request — missing file, unsupported format, or translation failed.',
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads',
        filename: (_req, file, cb) => {
          const randomName = Array(32)
            .fill(null)
            .map(() => Math.round(Math.random() * 16).toString(16))
            .join('');
          cb(null, `${randomName}${extname(file.originalname)}`);
        },
      }),
      fileFilter: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase();
        if (!ALLOWED_VIDEO_EXTS.includes(ext)) {
          cb(
            new BadRequestException(
              `Unsupported video format: ${ext}. Allowed: ${ALLOWED_VIDEO_EXTS.join(', ')}`,
            ),
            false,
          );
          return;
        }
        cb(null, true);
      },
      limits: {
        fileSize: 500 * 1024 * 1024, // 500MB max
      },
    }),
  )
  async translateVideo(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: TranslateVideoDto,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    if (!file) {
      throw new BadRequestException('No video file uploaded.');
    }

    // Disable request timeout for this heavy connection
    if (res.req) {
      res.req.setTimeout(0);
    }

    const voice = dto.voice;
    const apiKey = dto.apiKey;
    const targetLanguage = dto.targetLanguage || 'Vietnamese';

    try {
      const { outputPath, outputFilename } =
        await this.mediaService.translateVideo(
          file.path,
          voice,
          apiKey,
          targetLanguage,
        );

      // Get file size for Content-Length header
      const stat = fs.statSync(outputPath);

      // Set response headers
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', stat.size.toString());
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(outputFilename)}"`,
      );

      // Stream the video file to the client
      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);

      // Cleanup after streaming
      res.on('finish', () => {
        // Delete output video file
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
        // Delete uploaded video file
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });

      stream.on('error', () => {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      });
    } catch (error) {
      // Cleanup uploaded file on error
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      throw error;
    }
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { AudioTtsService } from './audio-tts.service';
import { TtsSrtDto } from './dto/tts-srt.dto';
import { CloneVoiceDto } from './dto/clone-voice.dto';

@ApiTags('TTS')
@Controller('tts')
export class AudioTtsController {
  constructor(private readonly audioTtsService: AudioTtsService) {}

  // ─────────────────────────────────────────────
  // GET /api/v1/tts/voices
  // ─────────────────────────────────────────────
  @Get('voices')
  @ApiOperation({
    summary: 'Get all available voices (built-in + cloned)',
    description:
      'Returns a list of built-in XTTS v2 speakers and user-cloned voices.',
  })
  @ApiResponse({
    status: 200,
    description: 'List of available voices.',
    schema: {
      type: 'object',
      properties: {
        builtin: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              type: { type: 'string', example: 'builtin' },
            },
          },
        },
        cloned: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              type: { type: 'string', example: 'cloned' },
              file: { type: 'string' },
              description: { type: 'string' },
            },
          },
        },
        total: { type: 'number' },
      },
    },
  })
  async getVoices() {
    return this.audioTtsService.getVoices();
  }

  // ─────────────────────────────────────────────
  // GET /api/v1/tts/languages
  // ─────────────────────────────────────────────
  @Get('languages')
  @ApiOperation({
    summary: 'Get supported languages',
    description:
      'Returns a list of all languages supported by the XTTS v2 model.',
  })
  @ApiResponse({ status: 200, description: 'List of supported languages.' })
  async getLanguages() {
    return this.audioTtsService.getLanguages();
  }

  // ─────────────────────────────────────────────
  // POST /api/v1/tts/clone-voice
  // ─────────────────────────────────────────────
  @Post('clone-voice')
  @ApiOperation({
    summary: 'Clone a voice from reference audio',
    description:
      'Upload a WAV/MP3 audio file (6-10s of clean speech) to create a cloned voice for TTS.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'name'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Reference audio file (WAV/MP3, 6-10s clean speech)',
        },
        name: {
          type: 'string',
          description: 'Name for the cloned voice',
          example: 'My Voice',
        },
        description: {
          type: 'string',
          description: 'Optional description',
          example: 'Vietnamese male voice',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Voice cloned successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid audio file or cloning failed.' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads',
        filename: (_req, file, cb) => {
          const randomName = Array(32)
            .fill(null)
            .map(() => Math.round(Math.random() * 16).toString(16))
            .join('');
          cb(null, `voice_${randomName}${extname(file.originalname)}`);
        },
      }),
      fileFilter: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase();
        if (!['.wav', '.mp3', '.flac', '.ogg'].includes(ext)) {
          cb(
            new BadRequestException(
              `Unsupported audio format: ${ext}. Allowed: .wav, .mp3, .flac, .ogg`,
            ),
            false,
          );
          return;
        }
        cb(null, true);
      },
      limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
    }),
  )
  async cloneVoice(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: CloneVoiceDto,
  ) {
    if (!file) {
      throw new BadRequestException('No audio file uploaded.');
    }

    return this.audioTtsService.cloneVoice(
      dto.name,
      dto.description || '',
      file.path,
      file.originalname,
    );
  }

  // ─────────────────────────────────────────────
  // POST /api/v1/tts/srt
  // ─────────────────────────────────────────────
  @Post('srt')
  @ApiOperation({
    summary: 'TTS from SRT subtitle file',
    description: `Upload an SRT file and generate speech audio that matches the subtitle timeline.
    
**Process:**
1. Parse SRT into segments with timestamps
2. TTS each segment using XTTS v2
3. Measure duration of each generated audio
4. Auto-stretch/compress each segment to match the SRT timeline
5. Insert silence for gaps between segments
6. Concatenate into a single audio file

**Returns:** Audio file (WAV or MP3) with speech perfectly aligned to the SRT timeline.`,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'language'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'SRT subtitle file',
        },
        speaker: {
          type: 'string',
          description:
            'Built-in speaker name (e.g., "Claribel Dervla"). Use GET /tts/voices to see available speakers.',
        },
        voice_id: {
          type: 'string',
          description:
            'Cloned voice ID (from POST /tts/clone-voice). Use this OR speaker, not both.',
        },
        language: {
          type: 'string',
          description: 'Language code',
          enum: [
            'en', 'es', 'fr', 'de', 'it', 'pt', 'pl',
            'tr', 'ru', 'nl', 'cs', 'ar', 'zh-cn',
            'ja', 'hu', 'ko', 'hi', 'vi',
          ],
          example: 'vi',
        },
        format: {
          type: 'string',
          description: 'Output audio format',
          enum: ['wav', 'mp3'],
          default: 'wav',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Generated audio file matching the SRT timeline.',
    content: {
      'audio/wav': { schema: { type: 'string', format: 'binary' } },
      'audio/mpeg': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid SRT file or TTS failed.' })
  @ApiResponse({
    status: 503,
    description: 'XTTS server is not available.',
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
          cb(null, `srt_${randomName}${extname(file.originalname)}`);
        },
      }),
      fileFilter: (_req, file, cb) => {
        const ext = extname(file.originalname).toLowerCase();
        if (ext !== '.srt') {
          cb(
            new BadRequestException(
              `Only .srt files are allowed. Got: ${ext}`,
            ),
            false,
          );
          return;
        }
        cb(null, true);
      },
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    }),
  )
  async ttsSrt(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: TtsSrtDto,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    if (!file) {
      throw new BadRequestException('No SRT file uploaded.');
    }

    if (!dto.speaker && !dto.voice_id) {
      // Cleanup uploaded file
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      throw new BadRequestException(
        'Either "speaker" (built-in voice) or "voice_id" (cloned voice) must be provided.',
      );
    }

    const format = dto.format || 'wav';

    const { outputPath, outputFilename, segments } =
      await this.audioTtsService.processSrt(
        file.path,
        dto.speaker,
        dto.voice_id,
        dto.language,
        format,
      );

    try {
      const stat = fs.statSync(outputPath);
      const mimeType =
        format === 'mp3' ? 'audio/mpeg' : 'audio/wav';

      // Add segment timeline info as a custom header
      res.setHeader(
        'X-TTS-Segments',
        JSON.stringify(
          segments.map((s) => ({
            id: s.segmentId,
            text: s.text.substring(0, 100),
            srtMs: `${s.srtStartMs}-${s.srtEndMs}`,
            ttsDurationMs: s.ttsDurationMs,
            tempo: s.tempoRatio,
          })),
        ),
      );

      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Length', stat.size.toString());
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(outputFilename)}"`,
      );

      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);

      res.on('finish', () => {
        // Cleanup the entire work directory
        const workDir = require('path').dirname(outputPath);
        this.audioTtsService.cleanupDir(workDir);
      });

      stream.on('error', () => {
        const workDir = require('path').dirname(outputPath);
        this.audioTtsService.cleanupDir(workDir);
      });
    } catch (error) {
      const workDir = require('path').dirname(outputPath);
      this.audioTtsService.cleanupDir(workDir);
      throw error;
    }
  }
}

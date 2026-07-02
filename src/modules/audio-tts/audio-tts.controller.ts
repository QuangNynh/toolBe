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
import * as os from 'os';
import * as path from 'path';

import { AudioTtsService } from './audio-tts.service';
import { GenerateTtsDto } from './dto/generate-tts.dto';
import { VieneuVoice } from './constants/voices.constant';

@ApiTags('Audio TTS')
@Controller('audio-tts')
export class AudioTtsController {
  constructor(private readonly audioTtsService: AudioTtsService) {}

  // ─── List Voices ──────────────────────────────────────────────────────

  @Get('voices')
  @ApiOperation({
    summary: 'Get the list of available VieNeu-TTS voices',
  })
  @ApiResponse({
    status: 200,
    description:
      'Returns supported voice list with id, label, gender, and character.',
  })
  getVoices(): { voices: VieneuVoice[]; total: number } {
    const voices = this.audioTtsService.getAvailableVoices();
    return { voices, total: voices.length };
  }

  // ─── Generate TTS from SRT ────────────────────────────────────────────

  @Post('generate')
  @ApiOperation({
    summary:
      'Upload an SRT file and generate a timeline-accurate MP3 audio using VieNeu-TTS (local)',
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
          description: 'SRT subtitle file',
        },
        voice: {
          type: 'string',
          description:
            'VieNeu-TTS voice name (e.g. Bình An, Xuân Vĩnh, Ngọc Linh)',
          example: 'Bình An',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Generated MP3 audio file download.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Bad request — missing file, invalid voice, or invalid SRT format.',
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
        if (ext !== '.srt') {
          cb(
            new BadRequestException('Only .srt files are allowed.'),
            false,
          );
          return;
        }
        cb(null, true);
      },
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max for SRT files
      },
    }),
  )
  async generateTts(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: GenerateTtsDto,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    if (!file) {
      throw new BadRequestException('No SRT file uploaded.');
    }

    // Read the SRT content
    const srtContent = fs.readFileSync(file.path, 'utf-8');

    // Clean up the uploaded file immediately after reading
    this.safeDelete(file.path);

    // Prepare the output MP3 path
    const originalName = path.basename(
      file.originalname,
      path.extname(file.originalname),
    );
    const outputFilename = `${originalName}_${dto.voice}.mp3`;
    const outputPath = path.join(os.tmpdir(), `tts-output-${Date.now()}.mp3`);

    try {
      // Run the full TTS pipeline (VieNeu-TTS local)
      await this.audioTtsService.generateAudioFromSrt(
        srtContent,
        dto.voice,
        outputPath,
      );

      // Verify the output exists
      if (!fs.existsSync(outputPath)) {
        throw new BadRequestException(
          'TTS generation completed but output file is missing.',
        );
      }

      // Get file size for Content-Length
      const stat = fs.statSync(outputPath);

      // Set response headers
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', stat.size.toString());
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(outputFilename)}"`,
      );

      // Stream the MP3 to the client
      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);

      // Cleanup once streaming finishes
      res.on('finish', () => {
        this.safeDelete(outputPath);
      });

      stream.on('error', () => {
        this.safeDelete(outputPath);
      });
    } catch (error) {
      // Cleanup on error
      this.safeDelete(outputPath);
      throw error;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /**
   * Safely delete a file without throwing if it doesn't exist.
   */
  private safeDelete(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

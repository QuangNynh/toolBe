import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { Response } from 'express';
import {
  TranslationService,
  ModelInfo,
  ModelListItem,
} from './translation.service';
import { TranslateDto } from './dto/translate.dto';
import { TranslateSrtDto } from './dto/translate-srt.dto';
import * as fs from 'fs';

interface TranslateResponse {
  translatedText: string;
  targetLanguage: string;
  model: string;
}

@ApiTags('Translation')
@Controller('translate')
export class TranslationController {
  constructor(private readonly translationService: TranslationService) {}

  // ─── Model Endpoints ──────────────────────────────────────────────────

  @Get('models')
  @ApiOperation({ summary: 'List all available Gemini models' })
  @ApiQuery({
    name: 'apiKey',
    required: false,
    description: 'Gemini API Key (optional — overrides server .env key)',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns list of all available models with their token limits.',
  })
  async listModels(
    @Query('apiKey') apiKey?: string,
  ): Promise<{ models: ModelListItem[]; total: number }> {
    const models = await this.translationService.listModels(apiKey);
    return { models, total: models.length };
  }

  @Get('model-info')
  @ApiOperation({
    summary: 'Get detailed info about a specific model (token limits, etc.)',
  })
  @ApiQuery({
    name: 'model',
    required: false,
    description: 'Model name (defaults to gemini-2.5-flash)',
    example: 'gemini-2.5-flash',
  })
  @ApiQuery({
    name: 'apiKey',
    required: false,
    description: 'Gemini API Key (optional — overrides server .env key)',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns model details including input/output token limits.',
  })
  async getModelInfo(
    @Query('model') model?: string,
    @Query('apiKey') apiKey?: string,
  ): Promise<ModelInfo> {
    return this.translationService.getModelInfo(model, apiKey);
  }

  // ─── Text Translation ─────────────────────────────────────────────────

  @Post()
  @ApiOperation({ summary: 'Translate text to a target language using Gemini' })
  @ApiResponse({
    status: 200,
    description: 'Translation completed successfully.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request — missing or invalid fields.',
  })
  @ApiResponse({
    status: 500,
    description: 'Translation failed due to an internal error.',
  })
  async translate(
    @Body() translateDto: TranslateDto,
  ): Promise<TranslateResponse> {
    const { text, targetLanguage, apiKey, model } = translateDto;
    const usedModel = model || 'gemini-2.5-flash';

    const translatedText = await this.translationService.translateText(
      text,
      targetLanguage,
      model,
      apiKey,
    );

    return {
      translatedText,
      targetLanguage,
      model: usedModel,
    };
  }

  // ─── SRT Translation ──────────────────────────────────────────────────

  @Post('srt')
  @ApiOperation({
    summary: 'Upload an SRT file, translate it, and download the translated SRT',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'targetLanguage'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'SRT subtitle file to translate',
        },
        targetLanguage: {
          type: 'string',
          description: 'Target language (e.g. Vietnamese, Japanese, Korean)',
          example: 'Vietnamese',
        },
        model: {
          type: 'string',
          description:
            'Gemini model to use (optional, defaults to gemini-2.5-flash)',
          example: 'gemini-2.5-flash',
        },
        apiKey: {
          type: 'string',
          description:
            'Gemini API Key (optional — overrides server .env key)',
          example: 'AIzaSy...',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Translated SRT file download.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request — missing file or invalid SRT format.',
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
    }),
  )
  async translateSrt(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: TranslateSrtDto,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    if (!file) {
      throw new BadRequestException('No SRT file uploaded.');
    }

    // Read the uploaded SRT file
    const srtContent = fs.readFileSync(file.path, 'utf-8');

    // Clean up uploaded file after reading
    try {
      fs.unlinkSync(file.path);
    } catch {
      this.translationService['logger'].warn(
        `Could not delete temp file: ${file.path}`,
      );
    }

    const result = await this.translationService.translateSrt(
      srtContent,
      dto.targetLanguage,
      dto.model,
      dto.apiKey,
    );

    // Build the output filename
    const originalName = file.originalname.replace(/\.srt$/i, '');
    const outputFilename = `${originalName}_${dto.targetLanguage}.srt`;

    // Send as downloadable SRT file
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(outputFilename)}"`,
    );
    res.setHeader('X-Translation-Model', result.model);
    res.setHeader('X-Total-Blocks', String(result.totalBlocks));
    res.setHeader('X-Total-Chunks', String(result.totalChunks));
    res.send(result.translatedSrt);
  }
}

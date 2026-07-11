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
import { GeminiChatDto } from './dto/gemini-chat.dto';
import { NineRouterChatDto } from './dto/ninerouter-chat.dto';
import { NineRouterTranslateSrtDto } from './dto/nine-router-translate-srt.dto';
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

  @Get('9router/models')
  @ApiOperation({ summary: 'List all supported models from 9Router' })
  @ApiResponse({
    status: 200,
    description: 'Returns list of all available models from 9Router.',
  })
  async list9RouterModels(): Promise<any> {
    return this.translationService.list9RouterModels();
  }

  @Get('9router/models/tts')
  @ApiOperation({ summary: 'List available Text-to-Speech models from 9Router' })
  @ApiResponse({
    status: 200,
    description: 'Returns list of all available TTS models from 9Router.',
  })
  async list9RouterTtsModels(): Promise<any> {
    return this.translationService.list9RouterTtsModels();
  }

  @Get('9router/voices')
  @ApiOperation({ summary: 'List supported TTS voices from 9Router by model and optionally country' })
  @ApiQuery({
    name: 'model',
    required: false,
    description: 'The TTS model ID (e.g. edge-tts, elevenlabs, openai/tts-1)',
    example: 'edge-tts',
  })
  @ApiQuery({
    name: 'country',
    required: false,
    description: 'Optional ISO country/language code (e.g. vi, en, zh-CN)',
    example: 'vi',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns supported voices list.',
  })
  async list9RouterTtsVoices(
    @Query('model') model?: string,
    @Query('country') country?: string,
  ): Promise<any> {
    return this.translationService.list9RouterTtsVoices(model, country);
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


  // ─── Gemini Chat ──────────────────────────────────────────────────────

  @Post('chat')
  @ApiOperation({ summary: 'Send a prompt directly to Gemini (like Gemini chat box)' })
  @ApiResponse({
    status: 200,
    description: 'Returns generated content response.',
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request — missing or invalid fields.',
  })
  @ApiResponse({
    status: 500,
    description: 'Content generation failed due to an internal error.',
  })
  async chat(
    @Body() chatDto: GeminiChatDto,
  ): Promise<{ response: string; model: string }> {
    const { prompt, model, history } = chatDto;
    const usedModel = model || 'gemini-2.5-flash';

    const responseText = await this.translationService.generateGeminiContent(
      prompt,
      model,
      history,
    );

    return {
      response: responseText,
      model: usedModel,
    };
  }

  @Post('9router/chat')
  @ApiOperation({
    summary: 'Send a prompt or chat history to 9Router, optionally streaming the response',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns the JSON response from 9Router, or a Server-Sent Events stream if stream: true.',
  })
  async chatWith9Router(
    @Body() chatDto: NineRouterChatDto,
    @Res() res: Response,
  ): Promise<void> {
    const { model, messages, stream } = chatDto;

    if (stream) {
      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.req.setTimeout(0);

      try {
        const streamGenerator = this.translationService.stream9RouterChat(
          model,
          messages,
        );

        for await (const textChunk of streamGenerator) {
          res.write(`data: ${JSON.stringify({ text: textChunk })}\n\n`);
        }

        res.write('data: [DONE]\n\n');
        res.end();
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'Internal Server Error';
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal Server Error', details: message });
        } else {
          res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
          res.end();
        }
      }
    } else {
      try {
        const responseData = await this.translationService.chatWith9Router(
          model,
          messages,
        );
        res.status(200).json(responseData);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'Internal Server Error';
        res.status(500).json({ error: 'Internal Server Error', details: message });
      }
    }
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
        customPrompt: {
          type: 'string',
          description: 'Custom prompt/instructions for translation (e.g., "Dịch sang tiếng Việt xưng hô thân mật")',
          example: 'Dịch sang tiếng Việt, xưng hô thân mật, giữ nguyên thuật ngữ kỹ thuật.',
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
      dto.customPrompt,
    );

    // Build the output filename
    const originalName = file.originalname.replace(/\.srt$/i, '');
    const filenameSuffix = dto.targetLanguage || 'translated';
    const outputFilename = `${originalName}_${filenameSuffix}.srt`;

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

  @Post('9router/srt')
  @ApiOperation({
    summary: 'Upload an SRT file, translate it via 9Router, and download the translated SRT',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'model'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'SRT subtitle file to translate',
        },
        model: {
          type: 'string',
          description: 'The 9Router model to use for translation',
          example: 'ag/gemini-2.5-flash',
        },
        targetLanguage: {
          type: 'string',
          description: 'Target language (optional, e.g. Vietnamese, Japanese, Korean)',
          example: 'Vietnamese',
        },
        customPrompt: {
          type: 'string',
          description: 'Custom prompt/instructions for translation (optional)',
          example: 'Dịch sang tiếng Việt, xưng hô thân mật, giữ nguyên thuật ngữ kỹ thuật.',
        },
        apiKey: {
          type: 'string',
          description: '9Router API Key (optional — overrides server .env key)',
          example: 'sk-...',
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
  async translateSrtWith9Router(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: NineRouterTranslateSrtDto,
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

    const result = await this.translationService.translateSrtWith9Router(
      srtContent,
      dto.model,
      dto.targetLanguage,
      dto.customPrompt,
      dto.apiKey,
    );

    // Build the output filename
    const originalName = file.originalname.replace(/\.srt$/i, '');
    const filenameSuffix = dto.targetLanguage || 'translated';
    const outputFilename = `${originalName}_${filenameSuffix}.srt`;

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

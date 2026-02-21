import {
  Controller,
  Post,
  Body,
  Res,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { TtsService } from './tts.service';
import { GenerateTtsDto } from './dto/tts.dto';

@ApiTags('TTS')
@Controller('tts')
export class TtsController {
  constructor(private readonly ttsService: TtsService) {}

  @Post('generate')
  @ApiOperation({ summary: 'Generate speech from text' })
  @ApiResponse({
    status: 200,
    description: 'Audio file generated successfully',
  })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async generateSpeech(
    @Body() generateTtsDto: GenerateTtsDto,
    @Res() res: Response,
  ) {
    try {
      const audioBuffer = await this.ttsService.generate(generateTtsDto.text);

      res.set({
        'Content-Type': 'audio/wav',
        'Content-Length': audioBuffer.length,
        'Content-Disposition': 'attachment; filename="speech.wav"',
      });

      return res.status(HttpStatus.OK).send(audioBuffer);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to generate speech';
      throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}

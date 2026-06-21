import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GenerateTtsDto {
  @ApiProperty({
    description: 'Voice name to use for TTS (e.g. Kore, Zephyr, Puck, Charon)',
    example: 'Kore',
  })
  @IsString()
  @IsNotEmpty()
  voice: string;

  @ApiPropertyOptional({
    description:
      'Gemini TTS model to use (defaults to gemini-2.5-flash-preview-tts)',
    example: 'gemini-2.5-flash-preview-tts',
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({
    description:
      'Gemini API Key (optional — overrides server .env key)',
    example: 'AIzaSy...',
  })
  @IsOptional()
  @IsString()
  apiKey?: string;
}


import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class TranslateSrtDto {
  @ApiProperty({
    description: 'The target language to translate subtitles into',
    example: 'Vietnamese',
  })
  @IsNotEmpty()
  @IsString()
  targetLanguage: string;

  @ApiPropertyOptional({
    description:
      'The Gemini model to use for translation (defaults to gemini-2.5-flash)',
    example: 'gemini-2.5-flash',
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({
    description:
      'Gemini API Key (optional — overrides server .env key if provided)',
    example: 'AIzaSy...',
  })
  @IsOptional()
  @IsString()
  apiKey?: string;
}

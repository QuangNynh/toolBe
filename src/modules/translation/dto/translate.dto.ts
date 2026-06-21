import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class TranslateDto {
  @ApiProperty({
    description: 'The text to translate',
    example: 'Hello, how are you?',
  })
  @IsNotEmpty()
  @IsString()
  text: string;

  @ApiProperty({
    description: 'The target language to translate into',
    example: 'Vietnamese',
  })
  @IsNotEmpty()
  @IsString()
  targetLanguage: string;

  @ApiPropertyOptional({
    description:
      'Gemini API Key (optional — overrides server .env key if provided)',
    example: 'AIzaSy...',
  })
  @IsOptional()
  @IsString()
  apiKey?: string;

  @ApiPropertyOptional({
    description:
      'The Gemini model to use for translation (defaults to gemini-2.5-flash)',
    example: 'gemini-2.5-flash',
  })
  @IsOptional()
  @IsString()
  model?: string;
}

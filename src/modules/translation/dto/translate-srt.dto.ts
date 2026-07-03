import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class TranslateSrtDto {
  @ApiPropertyOptional({
    description: 'The target language to translate subtitles into (e.g. Vietnamese, French, etc.)',
    example: 'Vietnamese',
  })
  @IsOptional()
  @IsString()
  targetLanguage?: string;

  @ApiPropertyOptional({
    description: 'Custom prompt/instructions for translation (e.g., "Dịch sang tiếng Việt xưng hô thân mật")',
    example: 'Dịch sang tiếng Việt, xưng hô thân mật, giữ nguyên thuật ngữ kỹ thuật.',
  })
  @IsOptional()
  @IsString()
  customPrompt?: string;

  @ApiPropertyOptional({
    description: 'The Gemini model to use for translation (defaults to gemini-2.5-flash)',
    example: 'gemini-2.5-flash',
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({
    description: 'Gemini API Key (optional — overrides server .env key if provided)',
    example: 'AIzaSy...',
  })
  @IsOptional()
  @IsString()
  apiKey?: string;
}

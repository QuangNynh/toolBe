import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class NineRouterTranslateSrtDto {
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

  @ApiProperty({
    description: 'The 9Router model to use for translation',
    example: 'ag/gemini-2.5-flash',
  })
  @IsNotEmpty()
  @IsString()
  model: string;

  @ApiPropertyOptional({
    description: '9Router API Key (optional — overrides server .env key if provided)',
    example: 'sk-...',
  })
  @IsOptional()
  @IsString()
  apiKey?: string;
}

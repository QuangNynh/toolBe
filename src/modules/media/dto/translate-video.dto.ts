import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class TranslateVideoDto {
  @ApiProperty({
    description: 'VieNeu-TTS voice name (e.g. Bình An, Xuân Vĩnh, Ngọc Linh, Ngọc Lan)',
    example: 'Bình An',
  })
  @IsNotEmpty()
  @IsString()
  voice: string;

  @ApiPropertyOptional({
    description: 'Gemini API Key to translate subtitles. If not provided, the default key from .env will be used.',
    example: 'AIzaSy...',
  })
  @IsOptional()
  @IsString()
  apiKey?: string;

  @ApiPropertyOptional({
    description: 'Target language for the subtitles and voice translation',
    example: 'Vietnamese',
    default: 'Vietnamese',
  })
  @IsOptional()
  @IsString()
  targetLanguage?: string;
}

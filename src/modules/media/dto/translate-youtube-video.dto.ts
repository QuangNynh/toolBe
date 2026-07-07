import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class TranslateYoutubeVideoDto {
  @ApiProperty({
    description: 'The YouTube video URL to translate',
    example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  })
  @IsNotEmpty()
  @IsString()
  url: string;

  @ApiProperty({
    description: 'VieNeu-TTS voice name (e.g. Bình An, Xuân Vĩnh, Ngọc Linh, Ngọc Lan)',
    example: 'Bình An',
  })
  @IsNotEmpty()
  @IsString()
  voice: string;

  @ApiPropertyOptional({
    description: '9Router API Key to translate subtitles. If not provided, the default key from .env will be used.',
    example: 'sk-...',
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

  @ApiPropertyOptional({
    description: 'The 9Router model to use for translation',
    example: 'ag/gemini-3-flash-agent',
    default: 'ag/gemini-3-flash-agent',
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({
    description: 'Video quality to download from YouTube (best, 1080p, 720p, 480p, 360p)',
    example: '1080p',
    default: '1080p',
  })
  @IsOptional()
  @IsString()
  quality?: string;
}

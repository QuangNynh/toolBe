import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class TtsSrtDto {
  @ApiPropertyOptional({
    description:
      'Built-in speaker name (e.g., "Claribel Dervla"). Leave empty if using cloned voice.',
    example: 'Claribel Dervla',
  })
  @IsOptional()
  @IsString()
  speaker?: string;

  @ApiPropertyOptional({
    description:
      'Cloned voice ID. Leave empty if using built-in speaker.',
    example: 'a1b2c3d4',
  })
  @IsOptional()
  @IsString()
  voice_id?: string;

  @ApiProperty({
    description: 'Language code for TTS synthesis',
    example: 'vi',
    enum: [
      'en', 'es', 'fr', 'de', 'it', 'pt', 'pl',
      'tr', 'ru', 'nl', 'cs', 'ar', 'zh-cn',
      'ja', 'hu', 'ko', 'hi', 'vi',
    ],
  })
  @IsNotEmpty()
  @IsString()
  @IsIn([
    'en', 'es', 'fr', 'de', 'it', 'pt', 'pl',
    'tr', 'ru', 'nl', 'cs', 'ar', 'zh-cn',
    'ja', 'hu', 'ko', 'hi', 'vi',
  ])
  language: string;

  @ApiPropertyOptional({
    description:
      'Output audio format for the final merged file',
    example: 'wav',
    enum: ['wav', 'mp3'],
    default: 'wav',
  })
  @IsOptional()
  @IsString()
  @IsIn(['wav', 'mp3'])
  format?: string;
}

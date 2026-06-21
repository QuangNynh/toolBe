import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class ExtractAudioDto {
  @ApiPropertyOptional({
    description:
      'Output audio format (defaults to mp3)',
    example: 'mp3',
    enum: ['mp3', 'wav', 'aac', 'flac', 'ogg'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['mp3', 'wav', 'aac', 'flac', 'ogg'])
  format?: string;

  @ApiPropertyOptional({
    description:
      'Audio bitrate in kbps (defaults to 192)',
    example: '192',
    enum: ['64', '128', '192', '256', '320'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['64', '128', '192', '256', '320'])
  bitrate?: string;
}

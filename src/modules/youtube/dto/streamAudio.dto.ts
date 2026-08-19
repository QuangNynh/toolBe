import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class StreamAudioDto {
  @ApiProperty({
    description: 'YouTube Video URL hoặc Video ID',
    example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  })
  @IsString()
  @IsNotEmpty()
  url: string;

  @ApiPropertyOptional({
    description: 'Định dạng audio đầu ra (mp3 hoặc m4a)',
    example: 'mp3',
    enum: ['mp3', 'm4a'],
    default: 'mp3',
  })
  @IsString()
  @IsOptional()
  format?: 'mp3' | 'm4a';
}


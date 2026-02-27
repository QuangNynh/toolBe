import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class StreamVideoDto {
  @ApiProperty({
    description: 'YouTube Video URL',
    example: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  })
  @IsString()
  @IsNotEmpty()
  url: string;

  @ApiProperty({
    description: 'Video quality (best, 1080p, 720p, 480p, 360p)',
    example: 'best',
    required: false,
    default: 'best',
  })
  @IsString()
  @IsOptional()
  quality?: string;
}

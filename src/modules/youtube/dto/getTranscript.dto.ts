import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class GetTranscriptDto {
  @ApiProperty({
    description: 'YouTube Video ID hoặc URL',
    example: 'dQw4w9WgXcQ',
  })
  @IsString()
  @IsNotEmpty()
  videoId: string;
}

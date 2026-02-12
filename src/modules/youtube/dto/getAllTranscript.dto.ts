import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GetAllTranscriptDto {
  @ApiProperty({
    description: 'YouTube Video ID hoặc URL',
    example: 'dQw4w9WgXcQ',
  })
  @IsString()
  @IsNotEmpty()
  videoId: string;

  @ApiProperty({
    description: 'Mã ngôn ngữ (vi, en, ja, etc.). Mặc định: vi',
    example: 'vi',
    required: false,
    default: 'vi',
  })
  @IsString()
  @IsOptional()
  lang?: string;
}

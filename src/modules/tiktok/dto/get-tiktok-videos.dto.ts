import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsNumber, IsString } from 'class-validator';

export class GetTikTokVideosDto {
  @ApiProperty({
    description: 'URL của kênh TikTok',
    example: 'https://www.tiktok.com/@gospelglow8',
  })
  @IsString()
  @IsNotEmpty()
  url: string;

  @ApiPropertyOptional({
    description: 'Giới hạn số lượng video cần lấy (Mặc định: 30)',
    example: 30,
  })
  @IsOptional()
  @IsNumber()
  limit?: number;
}

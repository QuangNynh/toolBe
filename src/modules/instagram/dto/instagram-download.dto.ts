import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class InstagramDownloadDto {
  @ApiProperty({
    description: 'Instagram Post/Reel URL or direct video ID (shortcode)',
    example: 'DZuYteMhr4j',
  })
  @IsString()
  @IsNotEmpty()
  url: string;
}

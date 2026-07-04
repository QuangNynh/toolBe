import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class DownloadTikTokVideoDto {
  @ApiProperty({
    description: 'URL của video TikTok cần tải',
    example: 'https://www.tiktok.com/@gospelglow8/video/7348463423828725038',
  })
  @IsString()
  @IsNotEmpty()
  url: string;
}

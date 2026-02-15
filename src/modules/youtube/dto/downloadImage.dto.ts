import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUrl } from 'class-validator';

export class DownloadImageDto {
  @ApiProperty({
    description: 'URL của ảnh cần tải xuống',
    example: 'https://i.ytimg.com/vi/VIDEO_ID/maxresdefault.jpg',
  })
  @IsString()
  @IsNotEmpty()
  @IsUrl()
  imageUrl: string;
}

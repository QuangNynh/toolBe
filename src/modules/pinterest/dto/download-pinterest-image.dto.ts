import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class DownloadPinterestImageDto {
  @ApiProperty({
    description: 'URL của pin Pinterest chứa ảnh cần tải',
    example: 'https://www.pinterest.com/pin/123456789/',
  })
  @IsString()
  @IsNotEmpty()
  url: string;
}

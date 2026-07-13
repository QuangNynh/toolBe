import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class DownloadPinterestVideoDto {
  @ApiProperty({
    description: 'URL của pin Pinterest chứa video cần tải',
    example: 'https://www.pinterest.com/pin/123456789/',
  })
  @IsString()
  @IsNotEmpty()
  url: string;
}

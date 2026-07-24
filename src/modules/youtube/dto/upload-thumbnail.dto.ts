import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class UploadThumbnailDto {
  @ApiProperty({
    description: 'ID của kênh YouTube đã liên kết để thực hiện upload',
    example: 'UCxxxxxxxxxxxxxxxxxxxxxx',
  })
  @IsNotEmpty()
  @IsString()
  channelId: string;

  @ApiProperty({
    description: 'ID của video YouTube cần cập nhật ảnh thumbnail',
    example: 'dQw4w9WgXcQ',
  })
  @IsNotEmpty()
  @IsString()
  videoId: string;

  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'File ảnh tải lên trực tiếp từ client (JPEG/PNG, < 2MB)',
  })
  file: any;
}

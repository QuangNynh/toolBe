import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class PinterestAuthCallbackDto {
  @ApiProperty({
    description: 'Authorization code nhận được từ Pinterest sau khi user đồng ý kết nối',
    example: 'code_1234567890',
  })
  @IsString()
  @IsNotEmpty()
  code: string;
}

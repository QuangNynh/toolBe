import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class YoutubeAuthCallbackDto {
  @ApiProperty({
    description: 'Authorization Code nhận được từ Google OAuth2 redirect',
    example: '4/0AXxxxx...',
  })
  @IsString()
  @IsNotEmpty()
  code: string;
}

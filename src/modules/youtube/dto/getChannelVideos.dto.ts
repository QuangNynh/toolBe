import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';



export class GetChannelVideosDto {
  @ApiProperty({
    description: 'URL của kênh YouTube',
    example: 'https://www.youtube.com/@channelname/',
  })
  @IsString()
  @IsNotEmpty()
  url: string;
}

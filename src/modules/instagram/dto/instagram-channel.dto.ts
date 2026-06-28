import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class InstagramChannelDto {
  @ApiProperty({
    description: 'Instagram Username or Profile URL',
    example: 'living_christian',
  })
  @IsString()
  @IsNotEmpty()
  username: string;
}

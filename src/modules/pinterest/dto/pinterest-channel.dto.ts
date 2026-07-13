import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class PinterestChannelDto {
  @ApiProperty({
    description:
      'URL trang Pinterest (profile, board, _created, _saved)',
    examples: {
      profile: { value: 'https://www.pinterest.com/username/' },
      board: { value: 'https://www.pinterest.com/username/board-name/' },
      created: { value: 'https://www.pinterest.com/username/_created' },
      saved: { value: 'https://www.pinterest.com/username/_saved' },
    },
    example: 'https://www.pinterest.com/username/',
  })
  @IsString()
  @IsNotEmpty()
  url: string;
}

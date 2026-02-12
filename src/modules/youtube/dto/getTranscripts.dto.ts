import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsString } from 'class-validator';

export class GetTranscriptsDto {
  @ApiProperty({
    description: 'Danh sách YouTube Video IDs hoặc URLs',
    example: ['dQw4w9WgXcQ', 'jNQXAC9IVRw'],
    type: [String],
  })
  @IsArray()
  @IsNotEmpty()
  @IsString({ each: true })
  videoIds: string[];
}

import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsArray,
  MaxLength,
  IsBoolean,
} from 'class-validator';

export class UpdateMetadataYoutubeDto {
  @ApiProperty({
    description: 'Channel ID của kênh YouTube đã kết nối (BE tự lookup token từ storage)',
    example: 'UCxxxxxxxxxxxxxxxxxxxxxxx',
  })
  @IsString()
  @IsNotEmpty()
  channelId: string;

  @ApiProperty({
    description: 'ID video YouTube cần cập nhật thông tin',
    example: 'dQw4w9WgXcQ',
  })
  @IsString()
  @IsNotEmpty()
  videoId: string;

  @ApiProperty({
    description: 'Tiêu đề mới cho video (tối đa 100 ký tự)',
    example: '10 Mẹo Hay Cho Cuộc Sống | Life Hacks',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  @ApiProperty({
    description: 'Mô tả mới cho video (tối đa 5000 ký tự)',
    example: 'Trong video này mình chia sẻ 10 mẹo hay...',
    maxLength: 5000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  description: string;

  @ApiProperty({
    description: 'Danh sách tags cho video',
    example: ['mẹo hay', 'life hacks', 'cuộc sống'],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({
    description: 'Cho biết video có chứa nội dung do AI tạo ra (Altered or synthetic content)',
    example: false,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  containsSyntheticMedia?: boolean;
}

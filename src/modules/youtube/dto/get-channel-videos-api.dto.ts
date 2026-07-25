import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsInt, Min, Max, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export class GetChannelVideosApiDto {
  @ApiProperty({
    description: 'ID kênh YouTube đã liên kết trong hệ thống',
    example: 'UCrI78yQm7H9ZTihuVs5nPLg',
  })
  @IsString()
  @IsNotEmpty()
  channelId: string;

  @ApiProperty({
    description: 'Số lượng kết quả tối đa trên mỗi trang (mặc định: 10, tối đa: 100)',
    example: 10,
    required: false,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  maxResults?: number = 10;

  @ApiProperty({
    description: 'Token phân trang nhận được từ trang trước (nextPageToken)',
    example: 'CAUQAA',
    required: false,
  })
  @IsOptional()
  @IsString()
  pageToken?: string;

  @ApiProperty({
    description: 'Lọc trạng thái quyền riêng tư của video (public, private, unlisted)',
    example: 'private',
    required: false,
    enum: ['public', 'private', 'unlisted'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['public', 'private', 'unlisted'])
  privacyStatus?: string;
}

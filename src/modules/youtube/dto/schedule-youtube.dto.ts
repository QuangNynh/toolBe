import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsArray,
  IsISO8601,
  MaxLength,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
} from 'class-validator';

// ────────────────────────────────────────────────────────────
// Custom validator: publishTime phải nằm trong tương lai
// (ít nhất 15 phút theo quy định của YouTube API)
// ────────────────────────────────────────────────────────────
@ValidatorConstraint({ name: 'IsFuturePublishTime', async: false })
class IsFuturePublishTimeConstraint implements ValidatorConstraintInterface {
  validate(value: string): boolean {
    const date = new Date(value);
    if (isNaN(date.getTime())) return false;

    // YouTube yêu cầu publishAt phải ít nhất 15 phút trong tương lai
    const minFuture = Date.now() + 15 * 60 * 1000;
    return date.getTime() >= minFuture;
  }

  defaultMessage(): string {
    return 'publishTime must be a valid ISO 8601 date at least 15 minutes in the future (YouTube API requirement)';
  }
}

export class ScheduleYoutubeDto {
  /**
   * Channel ID của kênh YouTube đã kết nối trong hệ thống.
   *
   * BE sẽ tự lookup refresh token từ file JSON dựa trên channelId này,
   * giống mô hình Pinterest — client không cần biết/gửi token.
   */
  @ApiProperty({
    description:
      'Channel ID của kênh YouTube đã kết nối (BE tự lookup token từ storage)',
    example: 'UCxxxxxxxxxxxxxxxxxxxxxxx',
  })
  @IsString()
  @IsNotEmpty()
  channelId: string;

  @ApiProperty({
    description:
      'ID video YouTube đã upload ở trạng thái Private, cần chuyển sang public theo lịch',
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
    description:
      'Thời điểm video tự động chuyển sang Public (ISO 8601, ít nhất 15 phút trong tương lai)',
    example: '2026-08-01T14:30:00.000Z',
  })
  @IsISO8601(
    { strict: true },
    { message: 'publishTime must be a valid ISO 8601 date string' },
  )
  @IsNotEmpty()
  @Validate(IsFuturePublishTimeConstraint)
  publishTime: string;
}

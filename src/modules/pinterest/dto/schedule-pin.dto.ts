import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsUrl,
  IsISO8601,
  IsOptional,
  MaxLength,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
} from 'class-validator';

// ────────────────────────────────────────────────────────────
// Custom validator: ensures the ISO 8601 timestamp is in the
// future (at least 60 seconds from now to account for cron
// scheduling granularity).
// ────────────────────────────────────────────────────────────
@ValidatorConstraint({ name: 'IsFutureDate', async: false })
class IsFutureDateConstraint implements ValidatorConstraintInterface {
  validate(value: string): boolean {
    const date = new Date(value);
    if (isNaN(date.getTime())) return false;

    const now = Date.now();
    const minFuture = now + 60_000; // at least 60 s in the future
    return date.getTime() >= minFuture;
  }

  defaultMessage(): string {
    return 'scheduleTime must be a valid ISO 8601 date at least 60 seconds in the future';
  }
}

export class SchedulePinDto {
  @ApiProperty({
    description: 'Username của tài khoản Pinterest đã kết nối',
    example: 'my_pinterest_username',
  })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({
    description: 'Pinterest board ID to post the pin to (numeric string)',
    example: '1234567890123456789',
  })
  @IsString()
  @IsNotEmpty()
  boardId: string;

  @ApiProperty({
    description: 'Pin title (max 100 characters)',
    example: '10 Modern Living Room Ideas',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  @ApiProperty({
    description: 'Pin description / body text (max 800 characters)',
    example: 'Discover the latest trends in modern interior design...',
    maxLength: 800,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(800)
  description: string;

  @ApiProperty({
    description: 'Public URL of the image to use as the pin media',
    example: 'https://example.com/images/living-room.jpg',
  })
  @IsUrl({}, { message: 'imageUrl must be a valid URL' })
  @IsNotEmpty()
  imageUrl: string;

  @ApiProperty({
    description:
      'ISO 8601 timestamp for when the pin should be published (must be at least 60 s in the future)',
    example: '2026-08-01T14:30:00.000Z',
  })
  @IsISO8601({ strict: true }, { message: 'scheduleTime must be a valid ISO 8601 date string' })
  @IsNotEmpty()
  @Validate(IsFutureDateConstraint)
  scheduleTime: string;

  @ApiProperty({
    description: 'Optional destination link attached to the pin',
    example: 'https://myblog.com/living-room-guide',
    required: false,
  })
  @IsOptional()
  @IsUrl({}, { message: 'link must be a valid URL' })
  link?: string;

  @ApiProperty({
    description: 'Alt text for accessibility (max 500 characters)',
    example: 'A bright modern living room with white furniture',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  altText?: string;
}

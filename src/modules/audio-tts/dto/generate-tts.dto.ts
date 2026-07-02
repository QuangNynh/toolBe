import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GenerateTtsDto {
  @ApiProperty({
    description:
      'Voice name to use for TTS (e.g. Bình An, Xuân Vĩnh, Ngọc Linh)',
    example: 'Bình An',
  })
  @IsString()
  @IsNotEmpty()
  voice: string;

  @ApiPropertyOptional({
    description:
      'Reference audio file path for voice cloning (optional)',
  })
  @IsOptional()
  @IsString()
  refAudioPath?: string;

  @ApiPropertyOptional({
    description:
      'Transcript of reference audio for voice cloning (optional)',
  })
  @IsOptional()
  @IsString()
  refText?: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CloneVoiceDto {
  @ApiProperty({
    description: 'Name for the cloned voice',
    example: 'My Voice',
  })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiPropertyOptional({
    description: 'Optional description for the voice',
    example: 'Vietnamese female voice',
  })
  @IsOptional()
  @IsString()
  description?: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class GetModelInfoDto {
  @ApiPropertyOptional({
    description: 'The model name to get info for (e.g. gemini-2.5-flash)',
    example: 'gemini-2.5-flash',
  })
  @IsOptional()
  @IsString()
  model?: string;
}

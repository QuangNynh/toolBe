import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GeminiChatDto {
  @ApiProperty({
    description: 'The user message / prompt to Gemini',
    example: 'Explain quantum computing in simple terms',
  })
  @IsNotEmpty()
  @IsString()
  prompt: string;

  @ApiPropertyOptional({
    description: 'The Gemini model to use (defaults to gemini-2.5-flash)',
    example: 'gemini-2.5-flash',
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({
    description: 'Gemini API Key (optional — overrides server .env key)',
    example: 'AIzaSy...',
  })
  @IsOptional()
  @IsString()
  apiKey?: string;
}

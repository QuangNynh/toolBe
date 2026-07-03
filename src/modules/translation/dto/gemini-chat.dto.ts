import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class ChatPartDto {
  @ApiProperty({ description: 'Text content of this part', example: 'Hello' })
  @IsString()
  text: string;
}

class ChatHistoryEntryDto {
  @ApiProperty({
    description: 'Role: "user" or "model"',
    example: 'user',
  })
  @IsString()
  role: string;

  @ApiProperty({
    description: 'Array of content parts',
    type: [ChatPartDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatPartDto)
  parts: ChatPartDto[];
}

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
    description:
      'Chat history from previous turns. Format: [{ role: "user", parts: [{ text: "..." }] }, ...]',
    type: [ChatHistoryEntryDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatHistoryEntryDto)
  history?: ChatHistoryEntryDto[];
}

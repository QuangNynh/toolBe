import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ChatMessageDto {
  @ApiProperty({
    description: 'Role of the message author (system, user, assistant)',
    example: 'user',
  })
  @IsString()
  @IsNotEmpty()
  role: string;

  @ApiProperty({
    description: 'Content of the message',
    example: 'Hello!',
  })
  @IsString()
  @IsNotEmpty()
  content: string;
}

export class NineRouterChatDto {
  @ApiProperty({
    description: 'The model to use (from the list of supported models)',
    example: 'ag/gemini-3.5-flash-low',
  })
  @IsNotEmpty()
  @IsString()
  model: string;

  @ApiProperty({
    description: 'The message history in OpenAI format',
    type: [ChatMessageDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  messages: ChatMessageDto[];

  @ApiPropertyOptional({
    description: 'Whether to stream the response (defaults to false)',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  stream?: boolean;
}

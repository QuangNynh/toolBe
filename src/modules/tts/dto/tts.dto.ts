import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class GenerateTtsDto {
  @ApiProperty({
    description:
      'Text to convert to speech (supports up to 200,000 characters)',
    example: 'Hello, this is a test message',
    maxLength: 200000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200000, {
    message: 'Text is too long. Maximum length is 200,000 characters',
  })
  text: string;
}

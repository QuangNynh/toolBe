import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class NineRouterSpeechDto {
  @ApiProperty({
    description: 'The 9Router TTS model/voice (e.g. edge-tts/ar-DZ-IsmaelNeural)',
    example: 'edge-tts/ar-DZ-IsmaelNeural',
  })
  @IsString()
  @IsNotEmpty()
  model: string;

  @ApiProperty({
    description: 'The text input to synthesize into speech',
    example: 'Hello, this is a text to speech test.',
  })
  @IsString()
  @IsNotEmpty()
  input: string;
}

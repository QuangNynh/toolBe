import { Module } from '@nestjs/common';
import { AudioTtsController } from './audio-tts.controller';
import { AudioTtsService } from './audio-tts.service';

@Module({
  controllers: [AudioTtsController],
  providers: [AudioTtsService],
  exports: [AudioTtsService],
})
export class AudioTtsModule {}

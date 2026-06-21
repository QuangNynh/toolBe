import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AudioTtsController } from './audio-tts.controller';
import { AudioTtsService } from './audio-tts.service';

@Module({
  imports: [ConfigModule.forRoot()],
  controllers: [AudioTtsController],
  providers: [AudioTtsService],
  exports: [AudioTtsService],
})
export class AudioTtsModule {}

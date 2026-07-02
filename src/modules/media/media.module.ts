import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { YouTubeModule } from '../youtube/youtube.module';
import { TranslationModule } from '../translation/translation.module';
import { AudioTtsModule } from '../audio-tts/audio-tts.module';

@Module({
  imports: [
    YouTubeModule,
    TranslationModule,
    AudioTtsModule,
  ],
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}

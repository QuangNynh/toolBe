import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { YouTubeModule } from './modules/youtube/youtube.module';
import { TranslationModule } from './modules/translation/translation.module';
import { MediaModule } from './modules/media/media.module';
import { AudioTtsModule } from './modules/audio-tts/audio-tts.module';
import { InstagramModule } from './modules/instagram/instagram.module';

@Module({
  imports: [
    YouTubeModule,
    TranslationModule,
    MediaModule,
    AudioTtsModule,
    InstagramModule,
  ],
  controllers: [AppController],
  providers: [AppService],
  exports: [],
})
export class AppModule {}


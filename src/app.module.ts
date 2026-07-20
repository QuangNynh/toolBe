import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { YouTubeModule } from './modules/youtube/youtube.module';
import { TranslationModule } from './modules/translation/translation.module';
import { MediaModule } from './modules/media/media.module';
import { AudioTtsModule } from './modules/audio-tts/audio-tts.module';
import { InstagramModule } from './modules/instagram/instagram.module';
import { TiktokModule } from './modules/tiktok/tiktok.module';
import { PinterestModule } from './modules/pinterest/pinterest.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    YouTubeModule,
    TranslationModule,
    MediaModule,
    AudioTtsModule,
    InstagramModule,
    TiktokModule,
    PinterestModule,
  ],
  controllers: [AppController],
  providers: [AppService],
  exports: [],
})
export class AppModule {}


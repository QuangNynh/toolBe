import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { YouTubeModule } from './modules/youtube/youtube.module';
import { TranslationModule } from './modules/translation/translation.module';
import { MediaModule } from './modules/media/media.module';

@Module({
  imports: [YouTubeModule, TranslationModule, MediaModule],
  controllers: [AppController],
  providers: [AppService],
  exports: [],
})
export class AppModule {}

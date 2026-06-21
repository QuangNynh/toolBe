import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { YouTubeModule } from './modules/youtube/youtube.module';
import { TranslationModule } from './modules/translation/translation.module';

@Module({
  imports: [YouTubeModule, TranslationModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

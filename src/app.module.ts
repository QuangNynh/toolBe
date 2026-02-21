import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { YouTubeModule } from './modules/youtube/youtube.module';
import { TtsModule } from './modules/tts/tts.module';

@Module({
  imports: [YouTubeModule, TtsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

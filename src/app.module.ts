import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { YouTubeModule } from './modules/youtube/youtube.module';

@Module({
  imports: [YouTubeModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

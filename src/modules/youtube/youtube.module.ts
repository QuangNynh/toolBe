import { Module } from '@nestjs/common';
import { YoutubeController } from './youtube.controller';
import { YoutubeService } from './youtube.service';

@Module({
  controllers: [YoutubeController],
  providers: [YoutubeService],
  imports: [],
  exports: [YoutubeService],
})
export class YouTubeModule {}

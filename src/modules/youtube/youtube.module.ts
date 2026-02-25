import { Module } from '@nestjs/common';
import { ProxyModule } from '../proxy/proxy.module';
import { YoutubeController } from './youtube.controller';
import { YoutubeService } from './youtube.service';

@Module({
  controllers: [YoutubeController],
  providers: [YoutubeService],
  imports: [ProxyModule],
  exports: [YoutubeService],
})
export class YouTubeModule {}

import { Controller, Post, Body, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { TiktokService } from './tiktok.service';
import { GetTikTokVideosDto } from './dto/get-tiktok-videos.dto';
import { DownloadTikTokVideoDto } from './dto/download-tiktok-video.dto';
import { DownloadTikTokAudioDto } from './dto/download-tiktok-audio.dto';

@ApiTags('TikTok')
@Controller('tiktok')
export class TiktokController {
  constructor(private readonly tiktokService: TiktokService) {}

  @Post('/channel-videos')
  @ApiOperation({ summary: 'Lấy danh sách video từ kênh TikTok dùng yt-dlp' })
  @ApiResponse({
    status: 200,
    description: 'Danh sách video kèm đầy đủ thông tin lượt xem, thích, mô tả',
  })
  async getChannelVideos(@Body() dto: GetTikTokVideosDto) {
    return this.tiktokService.getChannelVideos(dto.url, dto.limit);
  }

  @Post('/video')
  @ApiOperation({ summary: 'Tải xuống video TikTok chất lượng cao nhất dùng yt-dlp' })
  @ApiResponse({
    status: 200,
    description: 'Stream video MP4 download trực tiếp',
  })
  async downloadVideo(
    @Body() dto: DownloadTikTokVideoDto,
    @Res({ passthrough: false }) res: Response,
  ) {
    return this.tiktokService.downloadVideo(dto.url, res);
  }

  @Post('/audio')
  @ApiOperation({ summary: 'Tải xuống âm thanh (audio MP3) từ video TikTok dùng yt-dlp' })
  @ApiResponse({
    status: 200,
    description: 'Stream âm thanh MP3 download trực tiếp',
  })
  async downloadAudio(
    @Body() dto: DownloadTikTokAudioDto,
    @Res({ passthrough: false }) res: Response,
  ) {
    return this.tiktokService.downloadAudio(dto.url, res);
  }
}

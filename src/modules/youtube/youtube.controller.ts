import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { GetTranscriptDto } from './dto/getTranscript.dto';
import { GetTranscriptsDto } from './dto/getTranscripts.dto';
import { GetAllTranscriptDto } from './dto/getAllTranscript.dto';
import { StreamAudioDto } from './dto/streamAudio.dto';
import { GetChannelVideosDto } from './dto/getChannelVideos.dto';
import { DownloadImageDto } from './dto/downloadImage.dto';
import { YoutubeService } from './youtube.service';

@ApiTags('Youtube')
@Controller('youtube')
export class YoutubeController {
  constructor(private readonly ytService: YoutubeService) {}

  @Post('/transcript')
  @ApiOperation({ summary: 'Lấy transcript từ một video YouTube' })
  @ApiResponse({ status: 200, description: 'Transcript của video' })
  getTranscript(@Body() dto: GetTranscriptDto) {
    return this.ytService.getTranscript(dto.videoId);
  }

  @Post('/transcripts')
  @ApiOperation({ summary: 'Lấy transcript từ nhiều video YouTube' })
  @ApiResponse({
    status: 200,
    description: 'Danh sách transcript của các video',
  })
  getTranscripts(@Body() dto: GetTranscriptsDto) {
    return this.ytService.getTranscripts(dto.videoIds);
  }

  @Post('/audio')
  @ApiOperation({ summary: 'Stream audio từ video YouTube' })
  @ApiResponse({
    status: 200,
    description: 'Audio stream của video',
  })
  async streamAudio(@Body() dto: StreamAudioDto, @Res({ passthrough: false }) res: Response) {
    return this.ytService.streamAudio(dto.url, res);
  }

  @Post('/urls')
  @ApiOperation({ summary: 'Lấy danh sách video từ kênh YouTube' })
  @ApiResponse({
    status: 200,
    description: 'Danh sách video của kênh',
  })
  async getChannelVideos(@Body() dto: GetChannelVideosDto) {
    return this.ytService.getChannelVideos(dto.url);
  }

  @Post('/download-image')
  @ApiOperation({ summary: 'Tải xuống ảnh từ URL' })
  @ApiResponse({
    status: 200,
    description: 'Stream ảnh để tải xuống',
  })
  async downloadImage(@Body() dto: DownloadImageDto, @Res({ passthrough: false }) res: Response) {
    return this.ytService.downloadImage(dto.imageUrl, res);
  }
}

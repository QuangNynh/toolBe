import {
  Body,
  Controller,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { diskStorage } from 'multer';
import { extname } from 'path';
import { DownloadImageDto } from './dto/downloadImage.dto';
import { GetChannelVideosDto } from './dto/getChannelVideos.dto';
import { GetTranscriptDto } from './dto/getTranscript.dto';
import { GetTranscriptsDto } from './dto/getTranscripts.dto';
import { StreamAudioDto } from './dto/streamAudio.dto';
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
  async streamAudio(
    @Body() dto: StreamAudioDto,
    @Res({ passthrough: false }) res: Response,
  ) {
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
  async downloadImage(
    @Body() dto: DownloadImageDto,
    @Res({ passthrough: false }) res: Response,
  ) {
    return this.ytService.downloadImage(dto.imageUrl, res);
  }

  @Post('srt')
  @ApiOperation({ summary: 'Chuyển đổi file audio thành file SRT subtitle' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Audio file (mp3, wav, m4a, etc.)',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'File SRT được download tự động',
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads',
        filename: (_req, file, cb) => {
          const randomName = Array(32)
            .fill(null)
            .map(() => Math.round(Math.random() * 16).toString(16))
            .join('');
          cb(null, `${randomName}${extname(file.originalname)}`);
        },
      }),
    }),
  )
  async uploadAudio(
    @UploadedFile() file: Express.Multer.File,
    @Res({ passthrough: false }) res: Response,
  ) {
    if (!file) {
      throw new Error('No file uploaded');
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
    const srtContent = await this.ytService.audioToSrt(file.path);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
    return this.ytService.downloadSrtFile(srtContent, file.originalname, res);
  }
}

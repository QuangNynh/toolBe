import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
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
import { StreamVideoDto } from './dto/streamVideo.dto';
import { ScheduleYoutubeDto } from './dto/schedule-youtube.dto';
import { YoutubeAuthCallbackDto } from './dto/youtube-auth.dto';
import { GetChannelVideosApiDto } from './dto/get-channel-videos-api.dto';
import { UploadThumbnailDto } from './dto/upload-thumbnail.dto';
import { UpdateMetadataYoutubeDto } from './dto/update-metadata-youtube.dto';
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
  @ApiOperation({ summary: 'Stream audio từ video YouTube (sử dụng yt-dlp)' })
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

  @Post('/audio/youtubei')
  @ApiOperation({
    summary: 'Tải / Stream audio YouTube bằng thư viện youtubei.js',
    description: 'Trích xuất luồng audio trực tiếp từ YouTube thông qua thư viện youtubei.js (tốc độ cao, stream trực tiếp không cần lưu đĩa hoặc chuyển đổi sang MP3)',
  })
  @ApiResponse({
    status: 200,
    description: 'Audio stream (file M4A hoặc MP3) từ YouTube',
  })
  async downloadAudioYoutubei(
    @Body() dto: StreamAudioDto,
    @Res({ passthrough: false }) res: Response,
  ) {
    return this.ytService.downloadAudioYoutubei(dto.url, res, dto.format || 'mp3');
  }

  @Post('/video')
  @ApiOperation({ summary: 'Download video YouTube với chất lượng cao nhất' })
  @ApiResponse({
    status: 200,
    description: 'Video stream của video với chất lượng tốt nhất',
  })
  async streamVideo(
    @Body() dto: StreamVideoDto,
    @Res({ passthrough: false }) res: Response,
  ) {
    return this.ytService.downloadProcessAndStream(
      dto.url,
      dto.quality || '1080p',
      res,
    );
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
     
    const srtContent = await this.ytService.audioToSrt(file.path);
     
    return this.ytService.downloadSrtFile(srtContent, file.originalname, res);
  }

  @Post('script')
  @ApiOperation({ summary: 'Chuyển đổi file audio thành kịch bản văn bản (không có timeline)' })
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
    description: 'File TXT kịch bản được download tự động',
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
  async uploadAudioForScript(
    @UploadedFile() file: Express.Multer.File,
    @Res({ passthrough: false }) res: Response,
  ) {
    if (!file) {
      throw new Error('No file uploaded');
    }
     
    const srtContent = await this.ytService.audioToSrt(file.path);
    const scriptContent = this.ytService.srtToScript(srtContent);
     
    return this.ytService.downloadScriptFile(scriptContent, file.originalname, res);
  }

  // ──────────────────────────────────────────────────────────
  // YouTube OAuth2 Authentication
  // ──────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────
  // YouTube OAuth2 Authentication
  // ──────────────────────────────────────────────────────────

  @Get('/login')
  @ApiOperation({
    summary: 'Redirect trực tiếp đến trang Google OAuth2 để đăng nhập/liên kết YouTube',
  })
  async login(@Res() res: Response) {
    const url = this.ytService.getAuthUrl();
    return res.redirect(url);
  }

  @Get('/callback')
  @ApiOperation({
    summary: 'Nhận callback Authorization Code từ Google và trả về refresh_token',
  })
  @ApiResponse({
    status: 200,
    description: 'Xác thực thành công và trả về refresh_token',
  })
  async callback(@Query('code') code: string) {
    if (!code) {
      return {
        success: false,
        message: 'Missing code parameter',
      };
    }
    const refreshToken = await this.ytService.handleCallback(code);
    return {
      success: true,
      message: 'YouTube authentication successful',
      refresh_token: refreshToken,
    };
  }

  @Get('/auth/url')
  @ApiOperation({
    summary: 'Lấy URL đăng nhập OAuth2 của Google/YouTube',
  })
  @ApiResponse({
    status: 200,
    description: 'Trả về URL đăng nhập OAuth2',
  })
  getAuthUrl() {
    return { success: true, url: this.ytService.getAuthUrl() };
  }

  @Post('/auth/callback')
  @ApiOperation({
    summary: 'Xử lý Authorization Code từ Client gửi lên để kết nối kênh YouTube',
  })
  @ApiResponse({
    status: 200,
    description: 'Kết nối kênh YouTube thành công',
  })
  handleAuthCallback(@Body() dto: YoutubeAuthCallbackDto) {
    return this.ytService.handleAuthCallback(dto.code);
  }

  // ──────────────────────────────────────────────────────────
  // YouTube Channels Management (Connected Channels)
  // ──────────────────────────────────────────────────────────

  @Get('/channels')
  @ApiOperation({
    summary: 'Lấy danh sách các kênh YouTube đã kết nối',
  })
  @ApiResponse({
    status: 200,
    description: 'Mảng chứa danh sách kênh (đã ẩn token)',
  })
  getConnectedChannels() {
    return this.ytService.getConnectedChannels();
  }

  @Delete('/channels/:channelId')
  @ApiOperation({
    summary: 'Hủy kết nối một kênh YouTube bằng channelId',
  })
  @ApiResponse({
    status: 200,
    description: 'Hủy kết nối thành công',
  })
  disconnectChannel(@Param('channelId') channelId: string) {
    return this.ytService.disconnectChannel(channelId);
  }

  @Get('/channels/:channelId/check-token')
  @ApiOperation({
    summary: 'Kiểm tra trạng thái token của một kênh YouTube',
  })
  @ApiResponse({
    status: 200,
    description: 'Trả về trạng thái hoạt động của token và thời gian còn lại',
  })
  checkTokenStatus(@Param('channelId') channelId: string) {
    return this.ytService.checkTokenStatus(channelId);
  }

  // ──────────────────────────────────────────────────────────
  // YouTube Scheduled Video Publishing
  // ──────────────────────────────────────────────────────────

  @Get('/videos')
  @ApiOperation({
    summary: 'Lấy danh sách tất cả video từ một kênh YouTube đã liên kết',
  })
  @ApiResponse({
    status: 200,
    description: 'Danh sách các video bao gồm cả Private và Unlisted',
  })
  @ApiResponse({
    status: 400,
    description: 'Lỗi validate hoặc YouTube API trả lỗi',
  })
  async getVideos(@Query() dto: GetChannelVideosApiDto) {
    return this.ytService.getVideos(dto);
  }

  @Post('/schedule')
  @ApiOperation({
    summary:
      'Lên lịch tự động public video YouTube (chuyển từ Private sang Public theo giờ hẹn)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Video đã được lên lịch thành công — YouTube sẽ tự động public khi đến giờ',
  })
  @ApiResponse({
    status: 400,
    description: 'Lỗi validate hoặc YouTube API trả lỗi',
  })
  async scheduleVideo(@Body() dto: ScheduleYoutubeDto) {
    return this.ytService.scheduleVideo(dto);
  }

  @Post('/update-metadata')
  @ApiOperation({
    summary: 'Cập nhật thông tin chi tiết (metadata) của video YouTube bao gồm tiêu đề, mô tả, tags, và chế độ AI',
  })
  @ApiResponse({
    status: 200,
    description: 'Cập nhật metadata video thành công',
  })
  @ApiResponse({
    status: 400,
    description: 'Lỗi validate hoặc YouTube API trả lỗi',
  })
  async updateMetadata(@Body() dto: UpdateMetadataYoutubeDto) {
    return this.ytService.updateMetadata(dto);
  }

  @Post('/thumbnail')
  @ApiOperation({
    summary: 'Cập nhật thumbnail cho video YouTube bằng file upload trực tiếp',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    type: UploadThumbnailDto,
  })
  @ApiResponse({
    status: 200,
    description: 'Cập nhật ảnh thumbnail thành công',
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
          cb(null, `thumb_${randomName}${extname(file.originalname)}`);
        },
      }),
      fileFilter: (_req, file, cb) => {
        const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/jpg'];
        if (!allowedMimeTypes.includes(file.mimetype)) {
          return cb(new BadRequestException('Chỉ cho phép định dạng ảnh JPEG hoặc PNG.'), false);
        }
        cb(null, true);
      },
      limits: {
        fileSize: 2 * 1024 * 1024, // Giới hạn file tải lên trực tiếp là 2MB
      },
    }),
  )
  async updateThumbnail(
    @Body() dto: UploadThumbnailDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.ytService.updateThumbnail(dto, file);
  }
}

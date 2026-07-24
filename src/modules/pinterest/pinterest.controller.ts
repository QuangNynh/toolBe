import {
  Controller,
  Post,
  Body,
  Delete,
  Get,
  Res,
  Query,
  Param,
  BadRequestException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { PinterestService } from './pinterest.service';
import { PinterestChannelDto } from './dto/pinterest-channel.dto';
import { DownloadPinterestVideoDto } from './dto/download-pinterest-video.dto';
import { DownloadPinterestImageDto } from './dto/download-pinterest-image.dto';
import { DownloadPinterestAudioDto } from './dto/download-pinterest-audio.dto';
import { SchedulePinDto } from './dto/schedule-pin.dto';
import { PinterestAuthCallbackDto } from './dto/pinterest-auth.dto';

@ApiTags('Pinterest')
@Controller('pinterest')
export class PinterestController {
  constructor(private readonly pinterestService: PinterestService) {}

  @Post('/channel')
  @ApiOperation({
    summary:
      'Lấy danh sách pin từ kênh Pinterest (profile / board / _created / _saved) với file caching + phân trang',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    description:
      'Lọc loại pin: video, image (có thể kết hợp bằng dấu phẩy, vd: video,image)',
    example: 'video',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Số trang cần lấy (bắt đầu từ 1, mặc định: 1)',
    type: Number,
    example: 1,
  })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Số lượng pin trên mỗi trang (mặc định: 10, tối đa: 200)',
    type: Number,
    example: 10,
  })
  @ApiResponse({
    status: 200,
    description:
      'Danh sách pin với thông tin chi tiết và phân trang',
  })
  async getChannelPins(
    @Body() dto: PinterestChannelDto,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const parsedPage = page ? parseInt(page, 10) : 1;
    const parsedPageSize = pageSize ? parseInt(pageSize, 10) : 10;
    return this.pinterestService.getChannelPins(
      dto.url,
      type,
      parsedPage,
      parsedPageSize,
    );
  }

  @Post('/channel/export')
  @ApiOperation({
    summary:
      'Xuất toàn bộ pin của kênh Pinterest ra file Excel (từ cache)',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'Lọc loại pin trước khi xuất: video, image',
    example: 'image',
  })
  @ApiResponse({
    status: 200,
    description: 'Trả về tệp tin Excel (.xlsx) chứa toàn bộ pin đã lọc',
  })
  async exportChannelExcel(
    @Body() dto: PinterestChannelDto,
    @Res() res: Response,
    @Query('type') type?: string,
  ) {
    return this.pinterestService.exportChannelToExcel(dto.url, res, type);
  }

  @Post('/channel/export-images')
  @ApiOperation({
    summary:
      'Tải toàn bộ ảnh pin của kênh Pinterest dưới dạng file ZIP (từ cache)',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'Lọc loại pin trước khi tải ảnh: video, image',
    example: 'image',
  })
  @ApiResponse({
    status: 200,
    description:
      'Trả về tệp tin ZIP chứa toàn bộ ảnh pin được đổi tên theo STT',
  })
  async exportChannelImages(
    @Body() dto: PinterestChannelDto,
    @Res() res: Response,
    @Query('type') type?: string,
  ) {
    return this.pinterestService.exportImagesToZip(dto.url, res, type);
  }

  @Post('/channel/clear-cache')
  @ApiOperation({
    summary: 'Xóa toàn bộ bộ nhớ đệm (JSON) của tất cả các kênh Pinterest',
  })
  @ApiResponse({
    status: 200,
    description: 'Xóa tất cả các file cache JSON thành công',
  })
  async clearCache() {
    return this.pinterestService.clearAllCache();
  }

  @Post('/video')
  @ApiOperation({
    summary: 'Tải xuống video Pinterest chất lượng cao nhất từ 1 pin',
  })
  @ApiResponse({
    status: 200,
    description: 'Stream video MP4 download trực tiếp',
  })
  async downloadVideo(
    @Body() dto: DownloadPinterestVideoDto,
    @Res({ passthrough: false }) res: Response,
  ) {
    return this.pinterestService.downloadVideo(dto.url, res);
  }

  @Post('/image')
  @ApiOperation({
    summary: 'Tải xuống ảnh chất lượng cao từ 1 pin Pinterest',
  })
  @ApiResponse({
    status: 200,
    description: 'Stream ảnh download trực tiếp (JPG/PNG)',
  })
  async downloadImage(
    @Body() dto: DownloadPinterestImageDto,
    @Res({ passthrough: false }) res: Response,
  ) {
    return this.pinterestService.downloadImage(dto.url, res);
  }

  @Post('/audio')
  @ApiOperation({
    summary: 'Tải xuống âm thanh (audio MP3) từ video Pinterest',
  })
  @ApiResponse({
    status: 200,
    description: 'Stream âm thanh MP3 download trực tiếp',
  })
  async downloadAudio(
    @Body() dto: DownloadPinterestAudioDto,
    @Res({ passthrough: false }) res: Response,
  ) {
    return this.pinterestService.downloadAudio(dto.url, res);
  }

  // ──────────────────────────────────────────────────────────
  // Pinterest OAuth2 Authentication
  // ──────────────────────────────────────────────────────────

  @Get('/auth/url')
  @ApiOperation({
    summary: 'Lấy URL đăng nhập OAuth2 của Pinterest',
  })
  @ApiResponse({
    status: 200,
    description: 'Trả về URL đăng nhập OAuth2',
  })
  getAuthUrl() {
    return this.pinterestService.getAuthUrl();
  }

  @Post('/auth/callback')
  @ApiOperation({
    summary: 'Xử lý Authorization Code từ Client gửi lên để kết nối kênh',
  })
  @ApiResponse({
    status: 200,
    description: 'Kết nối tài khoản thành công',
  })
  handleAuthCallback(@Body() dto: PinterestAuthCallbackDto) {
    return this.pinterestService.handleAuthCallback(dto.code);
  }

  // ──────────────────────────────────────────────────────────
  // Pinterest Accounts Management (Connected Channels)
  // ──────────────────────────────────────────────────────────

  @Get('/accounts')
  @ApiOperation({
    summary: 'Lấy danh sách các kênh Pinterest đã kết nối',
  })
  @ApiResponse({
    status: 200,
    description: 'Mảng chứa danh sách tài khoản (đã ẩn token)',
  })
  getConnectedChannels() {
    return this.pinterestService.getConnectedChannels();
  }

  @Delete('/accounts/:username')
  @ApiOperation({
    summary: 'Hủy kết nối một kênh Pinterest bằng username',
  })
  @ApiResponse({
    status: 200,
    description: 'Hủy kết nối thành công',
  })
  disconnectChannel(@Param('username') username: string) {
    return this.pinterestService.disconnectChannel(username);
  }

  @Get('/accounts/:username/check-token')
  @ApiOperation({
    summary: 'Kiểm tra trạng thái token của một kênh',
  })
  @ApiResponse({
    status: 200,
    description: 'Trả về trạng thái hoạt động của token và thời gian còn lại',
  })
  checkTokenStatus(@Param('username') username: string) {
    return this.pinterestService.checkTokenStatus(username);
  }

  // ──────────────────────────────────────────────────────────
  // Scheduled Pin Posting (Pinterest v5 REST API)
  // ──────────────────────────────────────────────────────────

  @Post('/schedule')
  @ApiOperation({
    summary:
      'Lên lịch đăng pin tự động lên Pinterest qua Pinterest v5 API dựa trên tài khoản kết nối',
  })
  @ApiResponse({
    status: 201,
    description:
      'Lên lịch pin thành công — trả về jobName và thời gian chạy',
  })
  @ApiResponse({ status: 400, description: 'Lỗi validate hoặc tài khoản không tồn tại' })
  schedulePin(@Body() dto: SchedulePinDto) {
    return this.pinterestService.schedulePin(dto);
  }

  @Get('/schedule')
  @ApiOperation({
    summary: 'Xem danh sách các công việc đăng pin đã lên lịch',
  })
  @ApiResponse({
    status: 200,
    description: 'Danh sách các công việc đã lên lịch',
  })
  getScheduledJobs() {
    return this.pinterestService.getScheduledJobs();
  }

  @Delete('/schedule/:jobName')
  @ApiOperation({
    summary: 'Hủy lịch trình đăng pin bằng tên job',
  })
  @ApiResponse({ status: 200, description: 'Hủy lịch trình thành công' })
  @ApiResponse({ status: 400, description: 'Không tìm thấy job' })
  cancelScheduledJob(@Param('jobName') jobName: string) {
    return this.pinterestService.cancelScheduledJob(jobName);
  }
}

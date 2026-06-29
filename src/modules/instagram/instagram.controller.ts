import { Body, Controller, Post, Res, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { InstagramDownloadDto } from './dto/instagram-download.dto';
import { InstagramChannelDto } from './dto/instagram-channel.dto';
import { InstagramService } from './instagram.service';

@ApiTags('Instagram')
@Controller('instagram')
export class InstagramController {
  constructor(private readonly instagramService: InstagramService) {}

  @Post('/info')
  @ApiOperation({ summary: 'Lấy thông tin video từ Instagram (Post hoặc Reel)' })
  @ApiResponse({
    status: 200,
    description: 'Thông tin chi tiết của video',
  })
  async getVideoInfo(@Body() dto: InstagramDownloadDto) {
    return this.instagramService.getVideoInfo(dto.url);
  }

  @Post('/video')
  @ApiOperation({ summary: 'Tải video từ Instagram (Post hoặc Reel)' })
  @ApiResponse({
    status: 200,
    description: 'Video stream từ Instagram',
  })
  async downloadVideo(
    @Body() dto: InstagramDownloadDto,
    @Res({ passthrough: false }) res: Response,
  ) {
    return this.instagramService.downloadVideo(dto.url, res);
  }

  @Post('/audio')
  @ApiOperation({ summary: 'Tải audio từ Instagram (Post hoặc Reel)' })
  @ApiResponse({
    status: 200,
    description: 'Audio stream từ video Instagram (định dạng MP3)',
  })
  async downloadAudio(
    @Body() dto: InstagramDownloadDto,
    @Res({ passthrough: false }) res: Response,
  ) {
    return this.instagramService.downloadAudio(dto.url, res);
  }

  @Post('/channel')
  @ApiOperation({ summary: 'Lấy danh sách bài viết/video từ kênh/profile Instagram' })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'Lọc loại bài viết: video, image, carousel (có thể kết hợp bằng dấu phẩy, vd: image,carousel)',
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
    description: 'Số lượng bài viết trên mỗi trang (mặc định: 10)',
    type: Number,
    example: 10,
  })
  @ApiResponse({
    status: 200,
    description: 'Danh sách các bài viết/video của kênh và thông tin phân trang',
  })
  async getChannelVideos(
    @Body() dto: InstagramChannelDto,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const parsedPage = page ? parseInt(page, 10) : 1;
    const parsedPageSize = pageSize ? parseInt(pageSize, 10) : 10;
    return this.instagramService.getChannelVideos(
      dto.username,
      type,
      parsedPage,
      parsedPageSize,
    );
  }

  @Post('/channel/export')
  @ApiOperation({ summary: 'Xuất toàn bộ bài viết/video của kênh Instagram ra file Excel' })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'Lọc loại bài viết trước khi xuất: video, image, carousel (optional)',
    example: 'video',
  })
  @ApiResponse({
    status: 200,
    description: 'Trả về tệp tin Excel (.xlsx) chứa toàn bộ bài viết đã lọc',
  })
  async exportChannelExcel(
    @Body() dto: InstagramChannelDto,
    @Res() res: Response,
    @Query('type') type?: string,
  ) {
    return this.instagramService.exportChannelVideosToExcel(dto.username, res, type);
  }

  @Post('/channel/clear-cache')
  @ApiOperation({ summary: 'Xóa toàn bộ bộ nhớ đệm (JSON) của tất cả các kênh' })
  @ApiResponse({
    status: 200,
    description: 'Xóa tất cả các file cache JSON thành công',
  })
  async clearCache() {
    return this.instagramService.clearAllChannelCache();
  }
}

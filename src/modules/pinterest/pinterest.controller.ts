import { Controller, Post, Body, Res, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { PinterestService } from './pinterest.service';
import { PinterestChannelDto } from './dto/pinterest-channel.dto';
import { DownloadPinterestVideoDto } from './dto/download-pinterest-video.dto';
import { DownloadPinterestImageDto } from './dto/download-pinterest-image.dto';
import { DownloadPinterestAudioDto } from './dto/download-pinterest-audio.dto';

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
}

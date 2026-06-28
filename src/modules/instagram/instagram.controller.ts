import { Body, Controller, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { InstagramDownloadDto } from './dto/instagram-download.dto';
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
}

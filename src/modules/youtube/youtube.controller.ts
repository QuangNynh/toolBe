import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { GetTranscriptDto } from './dto/getTranscript.dto';
import { GetTranscriptsDto } from './dto/getTranscripts.dto';
import { GetAllTranscriptDto } from './dto/getAllTranscript.dto';
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
}

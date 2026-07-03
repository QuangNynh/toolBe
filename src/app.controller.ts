import { Controller, Get, Post, Body, Res } from '@nestjs/common';
import { Response } from 'express';
import { AppService } from './app.service';
import { TranslationService } from './modules/translation/translation.service';
import { GeminiChatDto } from './modules/translation/dto/gemini-chat.dto';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('Chat')
@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly translationService: TranslationService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Post('chat')
  @ApiOperation({
    summary:
      'Send a prompt to Gemini with streaming response (SSE). Supports multi-turn chat history.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Returns a Server-Sent Events stream of text chunks. Each chunk is JSON: { text: "..." }. Stream ends with data: [DONE].',
  })
  async chat(
    @Body() chatDto: GeminiChatDto,
    @Res() res: Response,
  ): Promise<void> {
    const { prompt, model, history } = chatDto;

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if behind proxy

    // Disable request timeout for streaming
    res.req.setTimeout(0);

    try {
      const stream = this.translationService.streamGeminiChat(
        prompt,
        model,
        history,
      );

      for await (const textChunk of stream) {
        res.write(`data: ${JSON.stringify({ text: textChunk })}\n\n`);
      }

      // Signal stream completion
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Internal Server Error';

      // If headers haven't been sent yet, send error as JSON
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error', details: message });
      } else {
        // If streaming already started, send error event and close
        res.write(
          `data: ${JSON.stringify({ error: message })}\n\n`,
        );
        res.end();
      }
    }
  }
}

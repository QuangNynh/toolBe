import { Controller, Get, Post, Body } from '@nestjs/common';
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
  @ApiOperation({ summary: 'Send a prompt directly to Gemini (like Gemini chat box)' })
  @ApiResponse({
    status: 200,
    description: 'Returns generated content response.',
  })
  async chat(
    @Body() chatDto: GeminiChatDto,
  ): Promise<{ response: string; model: string }> {
    const { prompt, model, apiKey } = chatDto;
    const usedModel = model || 'gemini-2.5-flash';

    const responseText = await this.translationService.generateGeminiContent(
      prompt,
      model,
      apiKey,
    );

    return {
      response: responseText,
      model: usedModel,
    };
  }
}

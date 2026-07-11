import {
  Injectable,
  Logger,
  OnModuleInit,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import axios from 'axios';

/** Represents a single SRT subtitle block */
interface SrtBlock {
  index: string;
  timestamp: string;
  text: string;
}

/** Model information returned by the API */
export interface ModelInfo {
  name: string;
  displayName: string;
  description: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  supportedActions: string[];
  version: string;
}

/** Summary of available models */
export interface ModelListItem {
  name: string;
  displayName: string;
  description: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
}

/** Result of SRT translation */
export interface TranslateSrtResult {
  translatedSrt: string;
  model: string;
  targetLanguage: string;
  totalBlocks: number;
  totalChunks: number;
}

@Injectable()
export class TranslationService implements OnModuleInit {
  private readonly logger = new Logger(TranslationService.name);

  /** Default client from .env (may be null if no .env key is configured) */
  private defaultGenAI: GoogleGenAI | null = null;

  private readonly DEFAULT_MODEL = 'gemini-2.5-flash';

  /** Max number of SRT blocks per translation request to avoid token limits */
  private readonly SRT_CHUNK_SIZE = 50;

  /** Retry configuration for transient API errors (503, 429, etc.) */
  private readonly MAX_RETRIES = 5;
  private readonly BASE_DELAY_MS = 2000;
  /** Delay between SRT chunk requests to avoid rate limits */
  private readonly CHUNK_DELAY_MS = 1000;

  private readonly SYSTEM_INSTRUCTION = [
    'You are a professional translator.',
    'Your sole purpose is to translate the given text into the requested target language.',
    'Return ONLY the translated text, nothing else.',
    'Do not add explanations, notes, alternatives, or any extra commentary.',
    'Preserve the original formatting, punctuation style, and tone.',
    'If the text is already in the target language, return it as-is.',
  ].join('\n');

  private readonly SRT_SYSTEM_INSTRUCTION = [
    'You are a professional subtitle translator.',
    'You will receive SRT subtitle text lines (one per line, separated by newlines).',
    'Translate EACH line to the target language.',
    'Return the translated lines in the EXACT same order, one per line.',
    'The number of output lines MUST equal the number of input lines.',
    'Do NOT add line numbers, timestamps, explanations, or any extra text.',
    'Preserve the meaning and tone. Keep translations concise to fit subtitle display.',
    'If a line is empty, return an empty line.',
  ].join('\n');

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const apiKey = this.configService.get<string>('GEMINI_API_KEY');

    if (apiKey) {
      this.defaultGenAI = new GoogleGenAI({ apiKey });
      this.logger.log(
        'Default GoogleGenAI client initialized from .env key.',
      );
    } else {
      this.logger.warn(
        'No GEMINI_API_KEY in .env. API key must be provided per-request.',
      );
    }
  }

  /**
   * Resolve which GoogleGenAI client to use.
   * Priority: per-request apiKey > .env default.
   */
  private getClient(apiKey?: string): GoogleGenAI {
    if (apiKey) {
      return new GoogleGenAI({ apiKey });
    }

    if (this.defaultGenAI) {
      return this.defaultGenAI;
    }

    throw new BadRequestException(
      'No API key provided. Either pass "apiKey" in the request body or configure GEMINI_API_KEY in .env.',
    );
  }

  // ─── Model Info ────────────────────────────────────────────────────────

  /**
   * Get detailed information about a specific model.
   */
  async getModelInfo(modelName?: string, apiKey?: string): Promise<ModelInfo> {
    const model = modelName || this.DEFAULT_MODEL;
    const client = this.getClient(apiKey);

    try {
      this.logger.debug(`Fetching model info for: ${model}`);

      const modelInfo = await client.models.get({ model });

      return {
        name: modelInfo.name ?? model,
        displayName: modelInfo.displayName ?? '',
        description: modelInfo.description ?? '',
        inputTokenLimit: modelInfo.inputTokenLimit ?? 0,
        outputTokenLimit: modelInfo.outputTokenLimit ?? 0,
        supportedActions: modelInfo.supportedActions ?? [],
        version: modelInfo.version ?? '',
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred';
      this.logger.error(`Failed to get model info: ${message}`, error);
      throw new InternalServerErrorException(
        `Failed to get model info for "${model}": ${message}`,
      );
    }
  }

  /**
   * List all available models.
   */
  async listModels(apiKey?: string): Promise<ModelListItem[]> {
    const client = this.getClient(apiKey);

    try {
      this.logger.debug('Listing all available models');

      const models: ModelListItem[] = [];
      const pager = await client.models.list();

      for await (const model of pager) {
        models.push({
          name: model.name ?? '',
          displayName: model.displayName ?? '',
          description: model.description ?? '',
          inputTokenLimit: model.inputTokenLimit ?? 0,
          outputTokenLimit: model.outputTokenLimit ?? 0,
        });
      }

      this.logger.debug(`Found ${models.length} available models`);
      return models;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred';
      this.logger.error(`Failed to list models: ${message}`, error);
      throw new InternalServerErrorException(
        `Failed to list models: ${message}`,
      );
    }
  }

  /**
   * List all supported models from 9Router.
   */
  async list9RouterModels(): Promise<any> {
    const apiKey = this.configService.get<string>('API_KEY_9ROUTER');
    if (!apiKey) {
      throw new BadRequestException(
        'API_KEY_9ROUTER is not configured in .env.',
      );
    }

    const baseUrl =
      this.configService.get<string>('BASE_URL_9ROUTER') ||
      'http://localhost:20128/v1';

    try {
      this.logger.debug(`Fetching 9Router models from ${baseUrl}/models`);
      const response = await axios.get(`${baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      return response.data;
    } catch (error: any) {
      const message =
        error.response?.data?.error?.message ||
        error.message ||
        'Unknown error occurred';
      this.logger.error(
        `Failed to list 9Router models: ${message}`,
        error.stack,
      );
      throw new InternalServerErrorException(
        `Failed to fetch models from 9Router: ${message}`,
      );
    }
  }

  /**
   * List available TTS models from 9Router.
   */
  async list9RouterTtsModels(): Promise<any> {
    const apiKey = this.configService.get<string>('API_KEY_9ROUTER');
    if (!apiKey) {
      throw new BadRequestException(
        'API_KEY_9ROUTER is not configured in .env.',
      );
    }

    const baseUrl =
      this.configService.get<string>('BASE_URL_9ROUTER') ||
      'http://localhost:20128/v1';

    try {
      this.logger.debug(`Fetching 9Router TTS models from ${baseUrl}/models/tts`);
      const response = await axios.get(`${baseUrl}/models/tts`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      return response.data;
    } catch (error: any) {
      const message =
        error.response?.data?.error?.message ||
        error.message ||
        'Unknown error occurred';
      this.logger.error(
        `Failed to list 9Router TTS models: ${message}`,
        error.stack,
      );
      throw new InternalServerErrorException(
        `Failed to fetch TTS models from 9Router: ${message}`,
      );
    }
  }

  /**
   * List available voices for a TTS model/provider from 9Router, optionally filtered by country.
   */
  async list9RouterTtsVoices(model?: string, country?: string): Promise<any> {
    const apiKey = this.configService.get<string>('API_KEY_9ROUTER');
    if (!apiKey) {
      throw new BadRequestException(
        'API_KEY_9ROUTER is not configured in .env.',
      );
    }

    const baseUrl =
      this.configService.get<string>('BASE_URL_9ROUTER') ||
      'http://localhost:20128/v1';
    const dashboardBaseUrl = baseUrl.endsWith('/v1') ? baseUrl.slice(0, -3) : baseUrl;

    // 1. Try to log in to 9Router dashboard to fetch voices dynamically
    const cookie = await this.get9RouterDashboardCookie(baseUrl);
    if (cookie) {
      try {
        const queryProviders = model
          ? [model]
          : ['elevenlabs', 'deepgram', 'inworld', 'edge-tts', 'local-device', 'gemini'];

        const results = await Promise.all(
          queryProviders.map(async (prov) => {
            try {
              const response = await axios.get(
                `${dashboardBaseUrl}/api/media-providers/tts/voices`,
                {
                  headers: { Cookie: cookie },
                  params: { provider: prov },
                },
              );
              let list: any[] = [];
              if (response.data && Array.isArray(response.data.voices)) {
                list = response.data.voices;
              } else if (response.data && Array.isArray(response.data)) {
                list = response.data;
              }
              // Map key fields consistently to match OpenAI style
              return list.map((v: any) => ({
                id: v.id,
                name: v.name,
                gender: v.gender,
                locale: v.locale || v.Locale || '',
                provider: prov,
              }));
            } catch (err: any) {
              this.logger.warn(
                `Failed to fetch voices from 9Router dashboard for provider ${prov}: ${err.message}`,
              );
              return [];
            }
          }),
        );

        let allVoices = results.flat();
        if (country) {
          allVoices = allVoices.filter((v) =>
            v.locale.toLowerCase().startsWith(country.toLowerCase()),
          );
        }
        return allVoices;
      } catch (err: any) {
        this.logger.warn(
          `Failed to fetch voices via 9Router dashboard API: ${err.message}. Falling back to static/public API...`,
        );
      }
    }

    // 2. Static/Public Fallback (if login fails or not configured)
    const geminiVoicesList = [
      { Name: 'Zephyr', ShortName: 'Zephyr', Gender: 'Male', FriendlyName: 'Zephyr (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Puck', ShortName: 'Puck', Gender: 'Male', FriendlyName: 'Puck (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Charon', ShortName: 'Charon', Gender: 'Male', FriendlyName: 'Charon (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Kore', ShortName: 'Kore', Gender: 'Female', FriendlyName: 'Kore (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Fenrir', ShortName: 'Fenrir', Gender: 'Male', FriendlyName: 'Fenrir (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Leda', ShortName: 'Leda', Gender: 'Female', FriendlyName: 'Leda (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Orus', ShortName: 'Orus', Gender: 'Male', FriendlyName: 'Orus (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Aoede', ShortName: 'Aoede', Gender: 'Female', FriendlyName: 'Aoede (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Callirrhoe', ShortName: 'Callirrhoe', Gender: 'Female', FriendlyName: 'Callirrhoe (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Autonoe', ShortName: 'Autonoe', Gender: 'Female', FriendlyName: 'Autonoe (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Enceladus', ShortName: 'Enceladus', Gender: 'Male', FriendlyName: 'Enceladus (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Iapetus', ShortName: 'Iapetus', Gender: 'Male', FriendlyName: 'Iapetus (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Umbriel', ShortName: 'Umbriel', Gender: 'Male', FriendlyName: 'Umbriel (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Algieba', ShortName: 'Algieba', Gender: 'Female', FriendlyName: 'Algieba (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Despina', ShortName: 'Despina', Gender: 'Female', FriendlyName: 'Despina (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Erinome', ShortName: 'Erinome', Gender: 'Female', FriendlyName: 'Erinome (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Algenib', ShortName: 'Algenib', Gender: 'Male', FriendlyName: 'Algenib (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Rasalgethi', ShortName: 'Rasalgethi', Gender: 'Male', FriendlyName: 'Rasalgethi (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Laomedeia', ShortName: 'Laomedeia', Gender: 'Female', FriendlyName: 'Laomedeia (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Achernar', ShortName: 'Achernar', Gender: 'Male', FriendlyName: 'Achernar (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Alnilam', ShortName: 'Alnilam', Gender: 'Male', FriendlyName: 'Alnilam (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Schedar', ShortName: 'Schedar', Gender: 'Female', FriendlyName: 'Schedar (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Gacrux', ShortName: 'Gacrux', Gender: 'Male', FriendlyName: 'Gacrux (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Pulcherrima', ShortName: 'Pulcherrima', Gender: 'Female', FriendlyName: 'Pulcherrima (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Achird', ShortName: 'Achird', Gender: 'Male', FriendlyName: 'Achird (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Zubenelgenubi', ShortName: 'Zubenelgenubi', Gender: 'Male', FriendlyName: 'Zubenelgenubi (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Vindemiatrix', ShortName: 'Vindemiatrix', Gender: 'Female', FriendlyName: 'Vindemiatrix (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Sadachbia', ShortName: 'Sadachbia', Gender: 'Female', FriendlyName: 'Sadachbia (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Sadaltager', ShortName: 'Sadaltager', Gender: 'Male', FriendlyName: 'Sadaltager (Gemini)', Locale: 'en-US', provider: 'gemini' },
      { Name: 'Sulfat', ShortName: 'Sulfat', Gender: 'Male', FriendlyName: 'Sulfat (Gemini)', Locale: 'en-US', provider: 'gemini' },
    ];

    let filteredGeminiVoices = geminiVoicesList;
    if (country) {
      filteredGeminiVoices = geminiVoicesList.filter((v) =>
        v.Locale.toLowerCase().startsWith(country.toLowerCase()),
      );
    }

    if (model?.toLowerCase() === 'gemini') {
      return filteredGeminiVoices;
    }

    if (model) {
      try {
        return await this.fetchVoicesForProvider(baseUrl, apiKey, model, country);
      } catch (error: any) {
        const message =
          error.response?.data?.error?.message ||
          error.message ||
          'Unknown error occurred';
        this.logger.error(
          `Failed to list 9Router TTS voices for provider ${model}: ${message}`,
          error.stack,
        );
        throw new InternalServerErrorException(
          `Failed to fetch TTS voices from 9Router: ${message}`,
        );
      }
    }

    const providers = ['elevenlabs', 'deepgram', 'inworld', 'edge-tts', 'local-device'];
    
    this.logger.debug(
      `Fetching 9Router TTS voices for all providers: ${providers.join(', ')} (country=${country || 'any'})`,
    );

    const results = await Promise.all(
      providers.map(async (prov) => {
        try {
          const data = await this.fetchVoicesForProvider(baseUrl, apiKey, prov, country);
          let list: any[] = [];
          if (Array.isArray(data)) {
            list = data;
          } else if (data && Array.isArray(data.voices)) {
            list = data.voices;
          } else if (data && typeof data === 'object') {
            list = Object.values(data);
          }
          return list.map((v: any) => ({ ...v, provider: prov }));
        } catch (err: any) {
          this.logger.warn(`Could not fetch voices for 9Router provider ${prov}: ${err.message || err}`);
          return [];
        }
      })
    );

    return [...results.flat(), ...filteredGeminiVoices];
  }

  /**
   * Log in to the 9Router dashboard API to retrieve the auth session cookie.
   */
  private async get9RouterDashboardCookie(baseUrl: string): Promise<string | null> {
    const password = this.configService.get<string>('PASSWORD_9ROUTER') || '123456';
    const dashboardBaseUrl = baseUrl.endsWith('/v1') ? baseUrl.slice(0, -3) : baseUrl;

    try {
      this.logger.debug(`Logging in to 9Router dashboard at ${dashboardBaseUrl}/api/auth/login...`);
      const response = await axios.post(`${dashboardBaseUrl}/api/auth/login`, {
        password,
      });

      const setCookie = response.headers['set-cookie'];
      if (!setCookie || setCookie.length === 0) {
        this.logger.warn('No Set-Cookie header returned from 9Router login.');
        return null;
      }

      const cookie = setCookie.find((c) => c.includes('auth_token'));
      if (!cookie) {
        this.logger.warn('auth_token cookie not found in 9Router login response.');
        return null;
      }

      return cookie.split(';')[0];
    } catch (err: any) {
      this.logger.warn(
        `Failed to log in to 9Router dashboard: ${err.response?.status || err.message}`,
      );
      return null;
    }
  }

  /**
   * Helper to fetch voices from 9Router for a specific provider.
   */
  private async fetchVoicesForProvider(
    baseUrl: string,
    apiKey: string,
    provider: string,
    country?: string,
  ): Promise<any> {
    const params: any = { provider };
    if (country) {
      params.lang = country;
    }
    const response = await axios.get(`${baseUrl}/audio/voices`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      params,
    });
    return response.data;
  }

  /**
   * Send a chat prompt or history to 9Router.
   */
  async chatWith9Router(
    model: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<any> {
    const apiKey = this.configService.get<string>('API_KEY_9ROUTER');
    if (!apiKey) {
      throw new BadRequestException(
        'API_KEY_9ROUTER is not configured in .env.',
      );
    }

    const baseUrl =
      this.configService.get<string>('BASE_URL_9ROUTER') ||
      'http://localhost:20128/v1';

    try {
      this.logger.debug(
        `Sending 9Router chat request to ${baseUrl}/chat/completions`,
      );
      const response = await axios.post(
        `${baseUrl}/chat/completions`,
        {
          model,
          messages,
          stream: false,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        },
      );
      return response.data;
    } catch (error: any) {
      const message =
        error.response?.data?.error?.message ||
        error.message ||
        'Unknown error occurred';
      this.logger.error(`9Router chat failed: ${message}`, error.stack);
      throw new InternalServerErrorException(
        `Failed to complete chat via 9Router: ${message}`,
      );
    }
  }

  /**
   * Stream a chat session with 9Router using SSE.
   */
  async *stream9RouterChat(
    model: string,
    messages: Array<{ role: string; content: string }>,
  ): AsyncGenerator<string> {
    const apiKey = this.configService.get<string>('API_KEY_9ROUTER');
    if (!apiKey) {
      throw new BadRequestException(
        'API_KEY_9ROUTER is not configured in .env.',
      );
    }

    const baseUrl =
      this.configService.get<string>('BASE_URL_9ROUTER') ||
      'http://localhost:20128/v1';

    this.logger.debug(`Streaming 9Router chat using model ${model}`);

    let response;
    try {
      response = await axios.post(
        `${baseUrl}/chat/completions`,
        {
          model,
          messages,
          stream: true,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          responseType: 'stream',
        },
      );
    } catch (error: any) {
      const message = error.message || 'Unknown error occurred';
      this.logger.error(`9Router streaming request failed: ${message}`, error);
      throw new InternalServerErrorException(
        `Failed to start 9Router stream: ${message}`,
      );
    }

    const stream = response.data;
    let buffer = '';

    for await (const chunk of stream) {
      const text = chunk.toString('utf8');
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'data: [DONE]') {
          return;
        }
        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.slice(6);
          try {
            const parsed = JSON.parse(dataStr);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              yield content;
            }
          } catch (e) {
            // Ignore incomplete line parse errors
          }
        }
      }
    }

    if (buffer) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
        const dataStr = trimmed.slice(6);
        try {
          const parsed = JSON.parse(dataStr);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            yield content;
          }
        } catch (e) {
          // Ignore
        }
      }
    }
  }

  // ─── Text Translation ─────────────────────────────────────────────────

  /**
   * Translate a text string to the target language.
   */
  async translateText(
    text: string,
    targetLanguage: string,
    modelName?: string,
    apiKey?: string,
  ): Promise<string> {
    if (!text) {
      throw new BadRequestException('Text is required.');
    }
    if (!targetLanguage) {
      throw new BadRequestException('Target language is required.');
    }

    const model = modelName || this.DEFAULT_MODEL;
    const client = this.getClient(apiKey);

    this.logger.debug(
      `Translating text to "${targetLanguage}" using ${model} (${text.length} chars)`,
    );

    const translatedText = await this.callWithRetry<string>(
      async () => {
        const response = await client.models.generateContent({
          model,
          contents: `Translate the following text to ${targetLanguage}:\n\n${text}`,
          config: {
            systemInstruction: this.SYSTEM_INSTRUCTION,
            temperature: 0.3,
          },
        });

        const result = response.text?.trim();
        if (!result) {
          throw new Error('Gemini returned an empty response.');
        }
        return result;
      },
      'Text translation',
    );

    this.logger.debug(
      `Translation completed successfully (${translatedText.length} chars)`,
    );

    return translatedText;
  }

  // ─── Gemini Chat / Content Generation ─────────────────────────────────

  /**
   * General chat / content generation (non-streaming).
   * Always uses the .env API key.
   */
  async generateGeminiContent(
    prompt: string,
    modelName?: string,
    history?: Array<{ role: string; parts: Array<{ text: string }> }>,
  ): Promise<string> {
    if (!prompt) {
      throw new BadRequestException('Prompt is required.');
    }

    const model = modelName || this.DEFAULT_MODEL;
    const client = this.getDefaultClient();

    this.logger.debug(
      `Generating content using model ${model} for prompt length: ${prompt.length} (via Stream accumulation)`,
    );

    try {
      const contents = [
        ...(history || []),
        { role: 'user', parts: [{ text: prompt }] },
      ];

      const responseStream = await client.models.generateContentStream({
        model,
        contents,
      });

      let resultText = '';
      for await (const chunk of responseStream) {
        if (chunk.text) {
          resultText += chunk.text;
        }
      }

      const result = resultText.trim();
      if (!result) {
        throw new Error('Gemini returned an empty response.');
      }
      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Gemini content generation failed: ${message}`, error);
      throw new InternalServerErrorException(
        `Gemini content generation failed: ${message}`,
      );
    }
  }

  /**
   * Streaming chat with Gemini via SSE (Server-Sent Events).
   * Always uses the .env API key.
   * Yields text chunks as they arrive from the model.
   */
  async *streamGeminiChat(
    prompt: string,
    modelName?: string,
    history?: Array<{ role: string; parts: Array<{ text: string }> }>,
  ): AsyncGenerator<string> {
    if (!prompt) {
      throw new BadRequestException('Prompt is required.');
    }

    const model = modelName || this.DEFAULT_MODEL;
    const client = this.getDefaultClient();

    this.logger.debug(
      `Streaming chat using model ${model} for prompt length: ${prompt.length}`,
    );

    try {
      const contents = [
        ...(history || []),
        { role: 'user', parts: [{ text: prompt }] },
      ];

      const responseStream = await client.models.generateContentStream({
        model,
        contents,
      });

      for await (const chunk of responseStream) {
        if (chunk.text) {
          yield chunk.text;
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Gemini streaming chat failed: ${message}`, error);
      throw new InternalServerErrorException(
        `Gemini streaming chat failed: ${message}`,
      );
    }
  }

  /**
   * Get the default GoogleGenAI client from .env.
   * Throws if no .env key is configured.
   */
  private getDefaultClient(): GoogleGenAI {
    if (this.defaultGenAI) {
      return this.defaultGenAI;
    }
    throw new BadRequestException(
      'No GEMINI_API_KEY configured in .env. Please set the GEMINI_API_KEY environment variable.',
    );
  }

  // ─── SRT Translation ──────────────────────────────────────────────────

  /**
   * Translate an SRT file content to the target language or using a custom prompt.
   * Parses the SRT, splits into chunks, translates each chunk,
   * and reassembles the SRT output.
   */
  async translateSrt(
    srtContent: string,
    targetLanguage?: string,
    modelName?: string,
    apiKey?: string,
    customPrompt?: string,
  ): Promise<TranslateSrtResult> {
    if (!srtContent) {
      throw new BadRequestException('SRT content is required.');
    }

    const model = modelName || this.DEFAULT_MODEL;
    const client = this.getClient(apiKey);

    const blocks = this.parseSrt(srtContent);

    if (blocks.length === 0) {
      throw new BadRequestException(
        'No valid SRT blocks found in the uploaded file.',
      );
    }

    const logMessage = customPrompt
      ? `Translating SRT: ${blocks.length} blocks using custom prompt and ${model}`
      : `Translating SRT: ${blocks.length} blocks to "${targetLanguage || 'Vietnamese'}" using ${model}`;
    this.logger.log(logMessage);

    const chunks = this.chunkArray(blocks, this.SRT_CHUNK_SIZE);
    const translatedBlocks: SrtBlock[] = [];

    for (let i = 0; i < chunks.length; i++) {
      this.logger.debug(
        `Translating chunk ${i + 1}/${chunks.length} (${chunks[i].length} blocks)`,
      );

      // Add delay between chunks to avoid rate limiting (skip for first chunk)
      if (i > 0) {
        await this.delay(this.CHUNK_DELAY_MS);
      }

      const translated = await this.translateSrtChunk(
        chunks[i],
        targetLanguage,
        model,
        client,
        customPrompt,
      );

      translatedBlocks.push(...translated);
    }

    const translatedSrt = this.assembleSrt(translatedBlocks);

    this.logger.log(
      `SRT translation completed: ${translatedBlocks.length} blocks in ${chunks.length} chunks`,
    );

    return {
      translatedSrt,
      model,
      targetLanguage: targetLanguage || 'Custom Prompt',
      totalBlocks: translatedBlocks.length,
      totalChunks: chunks.length,
    };
  }

  /**
   * Translate an SRT file content via 9Router.
   * Splits the content into chunks, translates each chunk, and reassembles the SRT output.
   */
  async translateSrtWith9Router(
    srtContent: string,
    modelName: string,
    targetLanguage?: string,
    customPrompt?: string,
    apiKeyOverride?: string,
  ): Promise<TranslateSrtResult> {
    if (!srtContent) {
      throw new BadRequestException('SRT content is required.');
    }
    if (!modelName) {
      throw new BadRequestException('Model name is required.');
    }

    const blocks = this.parseSrt(srtContent);

    if (blocks.length === 0) {
      throw new BadRequestException(
        'No valid SRT blocks found in the uploaded file.',
      );
    }

    const logMessage = customPrompt
      ? `Translating SRT via 9Router: ${blocks.length} blocks using custom prompt and ${modelName}`
      : `Translating SRT via 9Router: ${blocks.length} blocks to "${targetLanguage || 'Vietnamese'}" using ${modelName}`;
    this.logger.log(logMessage);

    const chunks = this.chunkArray(blocks, this.SRT_CHUNK_SIZE);
    const translatedBlocks: SrtBlock[] = [];

    for (let i = 0; i < chunks.length; i++) {
      this.logger.debug(
        `Translating chunk ${i + 1}/${chunks.length} (${chunks[i].length} blocks) via 9Router`,
      );

      // Add delay between chunks to avoid rate limiting (skip for first chunk)
      if (i > 0) {
        await this.delay(this.CHUNK_DELAY_MS);
      }

      const translated = await this.translateSrtChunkWith9Router(
        chunks[i],
        targetLanguage,
        modelName,
        customPrompt,
        apiKeyOverride,
      );
      translatedBlocks.push(...translated);
    }

    const translatedSrt = this.assembleSrt(translatedBlocks);

    this.logger.log(
      `SRT translation via 9Router completed: ${translatedBlocks.length} blocks in ${chunks.length} chunks`,
    );

    return {
      translatedSrt,
      model: modelName,
      targetLanguage: targetLanguage || 'Custom Prompt',
      totalBlocks: translatedBlocks.length,
      totalChunks: chunks.length,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  /**
   * Parse SRT content into structured blocks.
   *
   * SRT format:
   * 1
   * 00:00:01,000 --> 00:00:04,000
   * Hello world
   *
   * 2
   * 00:00:05,000 --> 00:00:08,000
   * How are you?
   */
  private parseSrt(content: string): SrtBlock[] {
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rawBlocks = normalized.split(/\n\n+/).filter((b) => b.trim());
    const blocks: SrtBlock[] = [];

    for (const raw of rawBlocks) {
      const lines = raw.trim().split('\n');
      if (lines.length < 3) continue;

      const index = lines[0].trim();
      const timestamp = lines[1].trim();
      const text = lines.slice(2).join('\n');

      // Validate timestamp format
      if (!timestamp.includes('-->')) continue;

      blocks.push({ index, timestamp, text });
    }

    return blocks;
  }

  /**
   * Translate a chunk of SRT blocks by sending only the text lines
   * to Gemini and mapping the results back.
   */
  private async translateSrtChunk(
    blocks: SrtBlock[],
    targetLanguage: string | undefined,
    model: string,
    client: GoogleGenAI,
    customPrompt?: string,
  ): Promise<SrtBlock[]> {
    // Extract text lines, preserving multi-line subtitles as single entries
    const textLines = blocks.map((b) => b.text.replace(/\n/g, ' '));
    
    let prompt: string;
    if (customPrompt) {
      prompt = `${customPrompt}\n\nYou will receive ${textLines.length} subtitle lines (one per line, separated by newlines). Process/translate each line accordingly. Return exactly ${textLines.length} processed lines, one per line. Do NOT add line numbers, explanations, or any extra text. Preserve order:\n\n${textLines.join('\n')}`;
    } else {
      const lang = targetLanguage || 'Vietnamese';
      prompt = `Translate each of the following ${textLines.length} subtitle lines to ${lang}. Return exactly ${textLines.length} translated lines, one per line:\n\n${textLines.join('\n')}`;
    }

    return this.callWithRetry<SrtBlock[]>(
      async () => {
        const response = await client.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: this.SRT_SYSTEM_INSTRUCTION,
            temperature: 0.3,
          },
        });

        const resultText = response.text?.trim();

        if (!resultText) {
          throw new Error('Gemini returned an empty response for SRT chunk.');
        }

        const translatedLines = resultText.split('\n').filter((l) => l.trim());

        // If the model returned a different number of lines, try best-effort mapping
        if (translatedLines.length !== blocks.length) {
          this.logger.warn(
            `Line count mismatch: expected ${blocks.length}, got ${translatedLines.length}. Using best-effort mapping.`,
          );
        }

        return blocks.map((block, i) => ({
          index: block.index,
          timestamp: block.timestamp,
          text: translatedLines[i] ?? block.text, // fallback to original if missing
        }));
      },
      'SRT chunk translation',
    );
  }

  /**
   * Translate a chunk of SRT blocks using 9Router and map results back.
   */
  private async translateSrtChunkWith9Router(
    blocks: SrtBlock[],
    targetLanguage: string | undefined,
    model: string,
    customPrompt?: string,
    apiKeyOverride?: string,
  ): Promise<SrtBlock[]> {
    const textLines = blocks.map((b) => b.text.replace(/\n/g, ' '));

    let prompt: string;
    if (customPrompt) {
      prompt = `${customPrompt}\n\nYou will receive ${textLines.length} subtitle lines (one per line, separated by newlines). Process/translate each line accordingly. Return exactly ${textLines.length} processed lines, one per line. Do NOT add line numbers, explanations, or any extra text. Preserve order:\n\n${textLines.join('\n')}`;
    } else {
      const lang = targetLanguage || 'Vietnamese';
      prompt = `Translate each of the following ${textLines.length} subtitle lines to ${lang}. Return exactly ${textLines.length} translated lines, one per line:\n\n${textLines.join('\n')}`;
    }

    const apiKey = apiKeyOverride || this.configService.get<string>('API_KEY_9ROUTER');
    if (!apiKey) {
      throw new BadRequestException(
        'APIKey 9Router is not configured or provided.',
      );
    }

    const baseUrl =
      this.configService.get<string>('BASE_URL_9ROUTER') ||
      'http://localhost:20128/v1';

    return this.callWithRetry<SrtBlock[]>(
      async () => {
        const response = await axios.post(
          `${baseUrl}/chat/completions`,
          {
            model,
            messages: [
              { role: 'system', content: this.SRT_SYSTEM_INSTRUCTION },
              { role: 'user', content: prompt },
            ],
            stream: false,
            temperature: 0.3,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
          },
        );

        const resultText = response.data?.choices?.[0]?.message?.content?.trim();

        if (!resultText) {
          throw new Error('9Router returned an empty response for SRT chunk.');
        }

        const translatedLines = resultText.split('\n').filter((l: string) => l.trim());

        if (translatedLines.length !== blocks.length) {
          this.logger.warn(
            `Line count mismatch via 9Router: expected ${blocks.length}, got ${translatedLines.length}. Using best-effort mapping.`,
          );
        }

        return blocks.map((block, i) => ({
          index: block.index,
          timestamp: block.timestamp,
          text: translatedLines[i] ?? block.text,
        }));
      },
      '9Router SRT chunk translation',
    );
  }

  /**
   * Reassemble translated SRT blocks into valid SRT string.
   */
  private assembleSrt(blocks: SrtBlock[]): string {
    return blocks
      .map((block) => `${block.index}\n${block.timestamp}\n${block.text}`)
      .join('\n\n');
  }

  /**
   * Split an array into chunks of a given size.
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }

    return chunks;
  }

  // ─── Retry & Rate Limit Helpers ────────────────────────────────────────

  /**
   * Retry a function with exponential backoff for transient API errors.
   * Retries on 503 (UNAVAILABLE), 429 (RESOURCE_EXHAUSTED), and 500 (INTERNAL).
   */
  private async callWithRetry<T>(
    fn: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        lastError = error;

        if (!this.isRetryableError(error)) {
          // Non-retryable error — fail immediately
          break;
        }

        if (attempt === this.MAX_RETRIES) {
          this.logger.error(
            `${operationName} failed after ${this.MAX_RETRIES} attempts.`,
          );
          break;
        }

        const delayMs = this.BASE_DELAY_MS * Math.pow(2, attempt - 1);
        const errMsg = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `${operationName} attempt ${attempt}/${this.MAX_RETRIES} failed. Error: "${errMsg}". ` +
            `Retrying in ${delayMs}ms...`,
        );

        await this.delay(delayMs);
      }
    }

    const message =
      lastError instanceof Error
        ? lastError.message
        : 'Unknown error occurred';
    this.logger.error(`${operationName} failed: ${message}`, lastError);
    throw new InternalServerErrorException(
      `${operationName} failed: ${message}`,
    );
  }

  /**
   * Check if an error is retryable (transient API errors).
   */
  private isRetryableError(error: unknown): boolean {
    const errorStr =
      error instanceof Error ? error.message : JSON.stringify(error);

    const retryableCodes = ['503', '429', 'UNAVAILABLE', 'RESOURCE_EXHAUSTED'];
    return retryableCodes.some((code) => errorStr.includes(code));
  }

  /**
   * Wait for a given number of milliseconds.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

import {
  Injectable,
  Logger,
  OnModuleInit,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';

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

  /** Retry configuration for transient API errors (503, 429, etc.) */
  private readonly MAX_RETRIES = 8;
  private readonly BASE_DELAY_MS = 3000;

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

  // ─── SRT Translation ──────────────────────────────────────────────────

  /**
   * Translate an SRT file content to the target language.
   * Sends the ENTIRE SRT in a single API call to minimize request count
   * (critical for free tier: 20 RPD / 5 RPM).
   */
  async translateSrt(
    srtContent: string,
    targetLanguage: string,
    modelName?: string,
    apiKey?: string,
  ): Promise<TranslateSrtResult> {
    const model = modelName || this.DEFAULT_MODEL;
    const client = this.getClient(apiKey);

    const blocks = this.parseSrt(srtContent);

    if (blocks.length === 0) {
      throw new BadRequestException(
        'No valid SRT blocks found in the uploaded file.',
      );
    }

    this.logger.log(
      `Translating SRT: ${blocks.length} blocks to "${targetLanguage}" using ${model} (single request)`,
    );

    const translatedBlocks = await this.translateAllBlocks(
      blocks,
      targetLanguage,
      model,
      client,
    );

    const translatedSrt = this.assembleSrt(translatedBlocks);

    this.logger.log(
      `SRT translation completed: ${translatedBlocks.length} blocks in 1 API call`,
    );

    return {
      translatedSrt,
      model,
      targetLanguage,
      totalBlocks: translatedBlocks.length,
      totalChunks: 1,
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
   * Translate ALL SRT blocks in a single API call.
   * Sends the entire SRT content and instructs the model to return
   * a fully translated SRT preserving structure.
   */
  private async translateAllBlocks(
    blocks: SrtBlock[],
    targetLanguage: string,
    model: string,
    client: GoogleGenAI,
  ): Promise<SrtBlock[]> {
    // Build the full SRT content to send
    const srtText = blocks
      .map((b) => `${b.index}\n${b.timestamp}\n${b.text}`)
      .join('\n\n');

    const prompt = [
      `Translate the following SRT subtitle file to ${targetLanguage}.`,
      'Rules:',
      '- Keep ALL index numbers exactly as they are.',
      '- Keep ALL timestamps exactly as they are.',
      '- Translate ONLY the subtitle text lines.',
      '- Preserve the exact SRT format: index, timestamp, translated text, separated by blank lines.',
      '- Do NOT add any extra text, explanations, or markdown formatting.',
      '',
      srtText,
    ].join('\n');

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
          throw new Error('Gemini returned an empty response for SRT translation.');
        }

        // Parse the translated SRT output back into blocks
        const translatedBlocks = this.parseSrt(resultText);

        if (translatedBlocks.length === 0) {
          throw new Error('Failed to parse translated SRT output from Gemini.');
        }

        // Warn if block count doesn't match
        if (translatedBlocks.length !== blocks.length) {
          this.logger.warn(
            `Block count mismatch: expected ${blocks.length}, got ${translatedBlocks.length}. Using best-effort mapping.`,
          );
        }

        // Map translated text back to original blocks (preserving original index/timestamp)
        return blocks.map((block, i) => ({
          index: block.index,
          timestamp: block.timestamp,
          text: translatedBlocks[i]?.text ?? block.text,
        }));
      },
      'SRT translation',
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

  // ─── Retry & Rate Limit Helpers ────────────────────────────────────────

  /**
   * Retry a function with exponential backoff for transient API errors.
   * Retries on 503 (UNAVAILABLE), 429 (RESOURCE_EXHAUSTED), and 500 (INTERNAL).
   * When 429 includes a retryDelay, uses that exact delay + buffer instead of backoff.
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

        // Try to parse the exact retry delay from the API error (e.g. "retryDelay":"29s")
        const apiDelay = this.parseRetryDelay(error);
        const backoffDelay = this.BASE_DELAY_MS * Math.pow(2, attempt - 1);
        // Use API-suggested delay if available (+ 2s buffer), otherwise use exponential backoff
        const delayMs = apiDelay ? apiDelay + 2000 : backoffDelay;

        this.logger.warn(
          `${operationName} attempt ${attempt}/${this.MAX_RETRIES} failed (retryable). ` +
            `Retrying in ${Math.round(delayMs / 1000)}s...` +
            (apiDelay ? ` (API suggested ${Math.round(apiDelay / 1000)}s)` : ''),
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
   * Parse the retryDelay from a Gemini API error response.
   * The API returns JSON like: {"details":[{"@type":"...RetryInfo","retryDelay":"29s"}]}
   * Also handles "Please retry in 29.678142979s." in the message text.
   * Returns delay in milliseconds, or null if not parseable.
   */
  private parseRetryDelay(error: unknown): number | null {
    const errorStr =
      error instanceof Error ? error.message : JSON.stringify(error);

    // Try parsing "retryDelay":"29s" from the JSON details
    const retryDelayMatch = errorStr.match(/"retryDelay"\s*:\s*"(\d+)s?"/);
    if (retryDelayMatch) {
      return parseInt(retryDelayMatch[1], 10) * 1000;
    }

    // Try parsing "Please retry in 29.678142979s." from the message
    const retryInMatch = errorStr.match(/retry in ([\d.]+)s/i);
    if (retryInMatch) {
      return Math.ceil(parseFloat(retryInMatch[1])) * 1000;
    }

    return null;
  }

  /**
   * Wait for a given number of milliseconds.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

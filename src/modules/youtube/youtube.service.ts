/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
 
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { exec, spawn } from 'child_process';
import { Response } from 'express';
import * as Ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import pLimit from 'p-limit';
import * as sharp from 'sharp';
import { promisify } from 'util';
import { exec as youtubeDlExec } from 'youtube-dl-exec';
import { fetchTranscript } from 'youtube-transcript-plus';
import { Innertube } from 'youtubei.js';
import type VideoInfo from 'youtubei.js/dist/src/parser/youtube/VideoInfo';
import { ProxyService } from '../proxy/proxy.service';
import { google } from 'googleapis';
import { ScheduleYoutubeDto } from './dto/schedule-youtube.dto';
import { GetChannelVideosApiDto } from './dto/get-channel-videos-api.dto';
import { UploadThumbnailDto } from './dto/upload-thumbnail.dto';
import SrtParser2 from 'srt-parser-2';

export interface YouTubeChannel {
  channelId: string;
  channelTitle: string;
  thumbnailUrl?: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt: number;   // timestamp in ms when access token expires
  connectedAt: number; // timestamp when channel was connected
}

const execPromise = promisify(exec);

@Injectable()
export class YoutubeService implements OnModuleInit {
  private youtube: Innertube;
  private proxyAgent: any;
  private readonly channelsFilePath = path.join(process.cwd(), 'data', 'youtube', 'channels.json');

  constructor(
    private readonly proxyService: ProxyService,
    private readonly configService: ConfigService,
  ) {
    // Đảm bảo thư mục lưu trữ kênh tồn tại
    const dir = path.dirname(this.channelsFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.channelsFilePath)) {
      fs.writeFileSync(this.channelsFilePath, JSON.stringify([]), 'utf-8');
    }
  }

  async onModuleInit() {
    // Suppress youtubei.js parsing warnings for "Remove ads" elements
    const originalConsoleError = console.error;
    const originalConsoleLog = console.log;

    console.error = (...args: any[]) => {
      const message = String(args[0] || '');
      if (
        message.includes('ParsingError') ||
        message.includes('Remove ads') ||
        message.includes(
          'LIST_ITEM_VIEW_MODEL_ENTITY_SELECTOR_TYPE_REMOVE_ADS_AD_STATE',
        )
      ) {
        return; // Ignore youtubei.js parsing errors
      }
      originalConsoleError.apply(console, args);
    };

    console.log = (...args: any[]) => {
      const message = String(args[0] || '');
      if (
        message.includes('[YOUTUBEJS][Parser]') ||
        message.includes('ParsingError')
      ) {
        return; // Ignore youtubei.js parser logs
      }
      originalConsoleLog.apply(console, args);
    };

    this.youtube = await Innertube.create();
    this.proxyAgent = this.proxyService.getProxyAgent();
  }

  private async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ---------------- METADATA BUILDER ---------------- */
  private buildMetadata(info: VideoInfo, videoId: string) {
    return {
      videoId,
      title: info.basic_info.title,
      description: info.basic_info.short_description,
      author: info.basic_info.author,
      channelId: info.basic_info.channel_id,
      thumbnails: info.basic_info.thumbnail,
      durationSeconds: info.basic_info.duration,
      viewCount: Number(info.basic_info.view_count || 0),
      likeCount: Number(info.basic_info.like_count || 0),
      isLive: info.basic_info.is_live,
      category: info.basic_info.category,
      keywords: info.basic_info.keywords,
    };
  }

  /* ---------------- FETCH TRANSCRIPT SAFE ---------------- */
  private async fetchTranscriptWithFallback(
    videoId: string,
    preferredLang = 'en',
  ) {
    const langs = [preferredLang, 'en', undefined];
    let usedLang = preferredLang;

    for (const lang of langs) {
      try {
        const transcript = await fetchTranscript(videoId, lang ? { lang } : {});
        usedLang = lang || 'auto';
        return { transcript, usedLang };
      } catch (err: any) {
         
        if (!err.message?.includes('transcript')) {
          throw err;
        }
      }
    }

    return { transcript: null, usedLang: null };
  }

  /* ---------------- GET SINGLE TRANSCRIPT ---------------- */
  async getTranscript(videoId: string, preferredLang = 'en') {
    const maxRetries = 10;
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const info = await this.youtube.getInfo(videoId);
        const metadata = this.buildMetadata(info, videoId);

        const { transcript, usedLang } = await this.fetchTranscriptWithFallback(
          videoId,
          preferredLang,
        );

        return {
          success: !!transcript,
          videoId,
          transcript,
          transcriptLanguage: usedLang,
          metadata,
          attempts: attempt,
        };
      } catch (error) {
         
        lastError = error;

        // Check for rate limiting
        if (error?.response?.status === 429) {
          console.log('Rate limited. Retrying after 10s...');
          await this.sleep(10000);
          continue;
        }

        if (attempt < maxRetries) {
          await this.sleep(1000 * attempt);
        }
      }
    }

    return {
      success: false,
      videoId,
      transcript: null,
      transcriptLanguage: null,
      metadata: null,
       
      error: lastError?.message || 'Unknown error',
      attempts: maxRetries,
    };
  }

  /* ---------------- METADATA ONLY ---------------- */
  async getAll(videoId: string) {
    try {
      const info = await this.youtube.getInfo(videoId);
      return {
        metadata: this.buildMetadata(info, videoId),
      };
    } catch (error) {
      throw new BadRequestException(
        `Error fetching video info: ${error.message}`,
      );
    }
  }

  /* ---------------- BATCH TRANSCRIPTS ---------------- */
  async getTranscripts(videoIds: string[], preferredLang = 'en') {
    const concurrency = 15; // số request chạy song song
    const limit = pLimit(concurrency);

    const tasks = videoIds.map((videoId) =>
      limit(() => this.getTranscript(videoId, preferredLang)),
    );

    const results = await Promise.all(tasks);

    return results;
  }
  private sanitizeFilename(filename: string): string {
    return (
      filename
        // eslint-disable-next-line no-control-regex
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '') // Remove invalid characters
        .replace(/[\u{1F600}-\u{1F64F}]/gu, '') // Remove emoticons
        .replace(/[\u{1F300}-\u{1F5FF}]/gu, '') // Remove symbols & pictographs
        .replace(/[\u{1F680}-\u{1F6FF}]/gu, '') // Remove transport & map symbols
        .replace(/[\u{2600}-\u{26FF}]/gu, '') // Remove misc symbols
        .replace(/[\u{2700}-\u{27BF}]/gu, '') // Remove dingbats
        .replace(/[\u{1F900}-\u{1F9FF}]/gu, '') // Remove supplemental symbols
        .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '') // Remove extended symbols
        .replace(/[^\x20-\x7E]/g, '') // Keep only ASCII printable characters
        .trim()
        .substring(0, 200) || 'audio'
    ); // Limit length and provide fallback
  }

  async getVideoFilename(url: string, suffix: string = ''): Promise<string> {
    try {
      let videoId: string;
      if (url.includes('v=')) {
        videoId = url.split('v=')[1].split('&')[0];
      } else {
        const parts = url.split('/');
        videoId = parts[parts.length - 1] || '';
      }
      if (videoId) {
        const info = await this.youtube.getInfo(videoId);
        const title = info.basic_info.title || 'video';
        return `${this.sanitizeFilename(title)}${suffix}.mp4`;
      }
    } catch {
      // Fallback
    }
    return `video${suffix}.mp4`;
  }

  private async runYtdlpWithRetry(
    formatString: string,
    rawFile: string,
    url: string,
    options: { mergeOutputFormat?: string } = {},
  ): Promise<void> {
    let success = false;
    let lastError: any = null;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ytdlpProxy = this.proxyService.getYtdlpProxy();
      const proxyArg = ytdlpProxy ? `--proxy "${ytdlpProxy}"` : '';
      const mergeArg = options.mergeOutputFormat ? `--merge-output-format ${options.mergeOutputFormat}` : '';
      
      const cmd = `yt-dlp --buffer-size 1024K --http-chunk-size 10M -f "${formatString}" ${mergeArg} -o "${rawFile}" --no-check-certificates --no-warnings ${proxyArg} "${url}"`;
      
      try {
        console.log(`Executing (Attempt ${attempt}/${maxAttempts}): ${cmd}`);
        await execPromise(cmd);
        success = true;
        break;
      } catch (err: any) {
        console.warn(`yt-dlp attempt ${attempt} failed: ${err.message}`);
        lastError = err;
        // Clean up partial downloads if any, so next attempt doesn't conflict
        try {
          const tempDir = path.dirname(rawFile);
          const baseName = path.basename(rawFile).split('.')[0];
          const files = fs.readdirSync(tempDir);
          for (const file of files) {
            if (file.startsWith(baseName)) {
              fs.unlinkSync(path.join(tempDir, file));
            }
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    if (!success) {
      throw lastError || new Error('All download attempts failed');
    }
  }

  async downloadVideoToPath(
    url: string,
    quality: string = '1080p',
  ): Promise<string> {
    // Build format string based on quality
    let formatString: string;
    switch (quality) {
      case '2160p':
      case '4k':
        formatString = 'bestvideo[height<=2160]+bestaudio/best[height<=2160]';
        break;
      case '1440p':
        formatString = 'bestvideo[height<=1440]+bestaudio/best[height<=1440]';
        break;
      case '1080p':
        formatString = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]';
        break;
      case '720p':
        formatString = 'bestvideo[height<=720]+bestaudio/best[height<=720]';
        break;
      case '480p':
        formatString = 'bestvideo[height<=480]+bestaudio/best[height<=480]';
        break;
      case '360p':
        formatString = 'bestvideo[height<=360]+bestaudio/best[height<=360]';
        break;
      default:
        formatString = 'bestvideo+bestaudio/best';
    }

    const tempDir = os.tmpdir();
    const baseName = `yt-${Date.now()}`;
    const rawFile = path.join(tempDir, `${baseName}-raw.mp4`);

    console.log(`Downloading video for local processing with quality: ${quality}`);

    await this.runYtdlpWithRetry(formatString, rawFile, url, { mergeOutputFormat: 'mp4' });

    return rawFile;
  }

  async streamAudio(url: string, res: Response) {
    let rawFile: string | null = null;
    let finalFile: string | null = null;
    try {
      // Extract video ID to get metadata
      let videoId: string;
      if (url.includes('v=')) {
        videoId = url.split('v=')[1].split('&')[0];
      } else {
        const parts = url.split('/');
        videoId = parts[parts.length - 1] || '';
      }

      let filename = 'audio.m4a';
      if (videoId) {
        try {
          const info = await this.youtube.getInfo(videoId);
          const sanitizedTitle = this.sanitizeFilename(
            info.basic_info.title || 'audio',
          );
          filename = `${sanitizedTitle}.m4a`;
        } catch {
          // If can't get info, use default filename
        }
      }

      const tempDir = os.tmpdir();
      const baseName = `yt-audio-${Date.now()}`;
      rawFile = path.join(tempDir, `${baseName}-raw.%(ext)s`);

      console.log(`Downloading audio to disk: ${url}`);

      await this.runYtdlpWithRetry('bestaudio[ext=m4a]/bestaudio/best', rawFile, url);

      // Find the actual downloaded file
      const files = fs.readdirSync(tempDir);
      const downloadedFile = files.find(f => f.startsWith(baseName));
      if (!downloadedFile) {
        throw new BadRequestException('Downloaded audio file does not exist');
      }
      const downloadedFilePath = path.join(tempDir, downloadedFile);
      rawFile = downloadedFilePath; // Update rawFile path for cleanup

      const isM4a = downloadedFile.endsWith('.m4a');
      
      if (isM4a) {
        console.log(`Audio is already in M4A format, streaming directly without transcoding...`);
        finalFile = downloadedFilePath;
        rawFile = null; // Set to null so cleanup doesn't delete it before streaming finishes
      } else {
        console.log(`Audio is in non-M4A format (${downloadedFile.split('.').pop()}), transcoding to MP3...`);
        finalFile = path.join(tempDir, `${baseName}-final.mp3`);
        filename = filename.replace(/\.m4a$/, '.mp3'); // Fallback filename to .mp3

        await new Promise<void>((resolve, reject) => {
          Ffmpeg(downloadedFilePath)
            .audioCodec('libmp3lame')
            .audioBitrate(128)
            .save(finalFile as string)
            .on('end', () => resolve())
            .on('error', (err: Error) => reject(err));
        });

        // Delete raw file
        try {
          fs.unlinkSync(downloadedFilePath);
        } catch {
          // Ignore
        }
        rawFile = null;
      }

      if (!fs.existsSync(finalFile)) {
        throw new BadRequestException('Audio file does not exist');
      }

      const stat = fs.statSync(finalFile);
      const fileSize = stat.size;

      res.setHeader('Content-Type', isM4a ? 'audio/mp4' : 'audio/mpeg');
      res.setHeader('Content-Length', fileSize.toString());
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );

      const stream = fs.createReadStream(finalFile);
      stream.pipe(res);

      const targetFile = finalFile;
      res.on('finish', () => {
        fs.unlink(targetFile, (err) => {
          if (err) console.error('Cleanup error:', err);
        });
      });

      stream.on('error', (error) => {
        console.error('Stream error:', error);
        fs.unlink(targetFile, () => {});
      });

    } catch (error: any) {
      console.error('Error in streamAudio:', error);
      if (rawFile && fs.existsSync(rawFile)) {
        try { fs.unlinkSync(rawFile); } catch {}
      }
      if (finalFile && fs.existsSync(finalFile)) {
        try { fs.unlinkSync(finalFile); } catch {}
      }
      if (!res.headersSent) {
        res.status(500).send(`Error downloading audio: ${error.message}`);
      }
    }
  }

  async downloadProcessAndStream(
    url: string,
    quality: string = '1080p',
    res: Response,
  ) {
    let rawFile: string | null = null;
    let finalFile: string | null = null;

    try {
      // Extract video ID to get metadata for filename
      let videoId: string;
      if (url.includes('v=')) {
        videoId = url.split('v=')[1].split('&')[0];
      } else {
        const parts = url.split('/');
        videoId = parts[parts.length - 1] || '';
      }

      let filename = 'video.mp4';
      if (videoId) {
        try {
          const info = await this.youtube.getInfo(videoId);
          const sanitizedTitle = this.sanitizeFilename(
            info.basic_info.title || 'video',
          );
          filename = `${sanitizedTitle}.mp4`;
        } catch {
          // If can't get info, use default filename
        }
      }

      // Build format string based on quality
      let formatString: string;
      switch (quality) {
        case '2160p':
        case '4k':
          formatString = 'bestvideo[height<=2160]+bestaudio/best[height<=2160]';
          break;
        case '1440p':
          formatString = 'bestvideo[height<=1440]+bestaudio/best[height<=1440]';
          break;
        case '1080p':
          formatString = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]';
          break;
        case '720p':
          formatString = 'bestvideo[height<=720]+bestaudio/best[height<=720]';
          break;
        case '480p':
          formatString = 'bestvideo[height<=480]+bestaudio/best[height<=480]';
          break;
        case '360p':
          formatString = 'bestvideo[height<=360]+bestaudio/best[height<=360]';
          break;
        default:
          formatString = 'bestvideo+bestaudio/best';
      }

      // Setup temp files
      const tempDir = os.tmpdir();
      const baseName = `yt-${Date.now()}`;
      rawFile = path.join(tempDir, `${baseName}-raw.mp4`);
      finalFile = path.join(tempDir, `${baseName}-final.mp4`);

      console.log(`Downloading video: ${filename} with quality: ${quality}`);

      // Step 1: Download video using system's yt-dlp binary
      await this.runYtdlpWithRetry(formatString, rawFile as string, url, { mergeOutputFormat: 'mp4' });

      console.log(`Download complete, re-encoding for compatibility...`);

      // Step 2: Re-encode with ffmpeg for CapCut/Canva compatibility
      if (!rawFile || !finalFile) {
        throw new BadRequestException('Temp file paths not initialized');
      }

      const reencode = await this.shouldReencodeVideo(rawFile);
      if (reencode) {
        console.log(`Re-encoding video for compatibility...`);
        await new Promise<void>((resolve, reject) => {
          Ffmpeg(rawFile as string)
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
              '-movflags +faststart', // Enable fast start
              '-preset fast', // Fast encoding
              '-crf 23', // Quality (lower = better, 23 is good)
              '-pix_fmt yuv420p', // Pixel format for compatibility
            ])
            .save(finalFile as string)
            .on('end', () => resolve())
            .on('error', (err: Error) => reject(err));
        });
      } else {
        console.log(`Video already compliant. Remuxing with stream copy...`);
        await new Promise<void>((resolve, reject) => {
          Ffmpeg(rawFile as string)
            .outputOptions([
              '-c copy',
              '-movflags +faststart',
            ])
            .save(finalFile as string)
            .on('end', () => resolve())
            .on('error', (err: Error) => reject(err));
        });
      }

      // Delete raw file
      fs.unlinkSync(rawFile);
      rawFile = null;

      console.log(`Re-encoding complete, streaming to client...`);

      // Get file stats
      const stat = fs.statSync(finalFile);
      const fileSize = stat.size;

      // Set headers for download
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', fileSize.toString());
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );
      res.setHeader('Accept-Ranges', 'bytes');

      // Stream the complete file
      const stream = fs.createReadStream(finalFile);
      stream.pipe(res);

      // Cleanup after streaming completes
      res.on('finish', () => {
        if (finalFile) {
          fs.unlink(finalFile, (err) => {
            if (err) console.error('Cleanup error:', err);
          });
        }
      });

      // Cleanup on error
      stream.on('error', (error) => {
        console.error('Stream error:', error);
        if (finalFile) {
          fs.unlink(finalFile, () => {});
        }
      });
    } catch (err: any) {
      // Cleanup on error
      if (rawFile && fs.existsSync(rawFile)) {
        fs.unlinkSync(rawFile);
      }
      if (finalFile && fs.existsSync(finalFile)) {
        fs.unlinkSync(finalFile);
      }
      throw new BadRequestException(`Video processing failed: ${err.message}`);
    }
  }

  async getChannelVideos(url: string, concurrency = 10) {
    try {
      // Bước 1: flatPlaylist:true → lấy danh sách video ID rất nhanh
      const ytDlOpts: any = {
        dumpSingleJson: true,
        flatPlaylist: true,
        noWarnings: true,
        noCheckCertificates: true,
      };
      const ytdlpProxy = this.proxyService.getYtdlpProxy();
      if (ytdlpProxy) {
        ytDlOpts.proxy = ytdlpProxy;
      }
      const result = await youtubeDlExec(url, ytDlOpts);

      if (!result) {
        throw new BadRequestException('No data returned from youtube-dl');
      }

      const parsed = JSON.parse(result.stdout);
      const rawEntries: any[] = parsed.entries ?? [parsed];

      // Bước 2: batch-fetch full metadata song song qua youtubei.js
      const limit = pLimit(concurrency);

      const videos = await Promise.all(
        rawEntries.map((entry: any) =>
          limit(async () => {
            const id: string = entry.id ?? entry.url?.split('v=')[1]?.split('&')[0];
            if (!id) return null;

            try {
              const info = await this.youtube.getInfo(id);
              const b = info.basic_info;
              const createdAt = b.start_timestamp
                ? new Date(b.start_timestamp).toISOString()
                : ((info as any).primary_info?.published?.toString() ||
                   (info as any).primary_info?.published?.text ||
                   null);

              return {
                id,
                title: b.title ?? entry.title ?? null,
                url: `https://www.youtube.com/watch?v=${id}`,
                description: b.short_description ?? null,
                duration: b.duration ?? null,
                view_count: Number(b.view_count ?? 0),
                like_count: Number(b.like_count ?? 0),
                channel_id: b.channel_id ?? null,
                channel: b.author ?? null,
                thumbnails: b.thumbnail ?? null,
                keywords: b.keywords ?? [],
                is_live: b.is_live ?? false,
                category: b.category ?? null,
                created_at: createdAt,
              };
            } catch {
              // Nếu video bị ẩn/lỗi thì trả về thông tin cơ bản từ flatPlaylist
              return {
                id,
                title: entry.title ?? null,
                url: `https://www.youtube.com/watch?v=${id}`,
                description: null,
                duration: entry.duration ?? null,
                view_count: null,
                like_count: null,
                channel_id: null,
                channel: entry.uploader ?? null,
                thumbnails: null,
                keywords: [],
                is_live: false,
                category: null,
                created_at: null,
              };
            }
          }),
        ),
      );


      const validVideos = videos.filter(Boolean);

      return {
        type: parsed.extractor_key ?? parsed._type ?? 'unknown',
        channelId: parsed.channel_id ?? parsed.uploader_id ?? null,
        channel: parsed.channel ?? parsed.uploader ?? null,
        channelUrl: parsed.channel_url ?? null,
        title: parsed.title ?? null,
        totalVideos: validVideos.length,
        videos: validVideos,
      };
    } catch (error) {
      throw new BadRequestException(
        `Error fetching channel videos: ${(error as Error).message}`,
      );
    }
  }

  /* ---------------- DOWNLOAD IMAGE ---------------- */
  async downloadImage(imageUrl: string, res: Response) {
    try {
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        httpsAgent: this.proxyAgent,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 300,
      });

      let buffer = Buffer.from(response.data);

      // Validate buffer is not empty
      if (buffer.length === 0) {
        throw new BadRequestException('Downloaded image is empty');
      }

      // Detect actual image type from buffer magic numbers
      let contentType = 'image/jpeg';
      let extension = 'jpg';
      let needsConversion = false;

      if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        contentType = 'image/jpeg';
        extension = 'jpg';
      } else if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47
      ) {
        contentType = 'image/png';
        extension = 'png';
      } else if (
        buffer[0] === 0x47 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46
      ) {
        contentType = 'image/gif';
        extension = 'gif';
      } else if (
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46
      ) {
        // WebP detected - convert to JPG for Canva compatibility
        needsConversion = true;
        contentType = 'image/jpeg';
        extension = 'jpg';
      }

      // Convert WebP to JPG if needed
      if (needsConversion) {
        console.log('Converting WebP to JPG for Canva compatibility...');
        buffer = await sharp(buffer).jpeg({ quality: 95 }).toBuffer();
      }

      // Extract filename from URL
      const urlParts = imageUrl.split('/');
      const urlFilename = urlParts[urlParts.length - 1]
        .split('?')[0]
        .split('.')[0];
      const sanitizedFilename = this.sanitizeFilename(urlFilename || 'image');
      const filename = `${sanitizedFilename}.${extension}`;

      console.log(
        `Downloading image: ${filename}, size: ${buffer.length} bytes, type: ${contentType}`,
      );

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', buffer.length.toString());
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      res.end(buffer);
    } catch (error) {
      console.error('Image download error:', error);
      throw new BadRequestException(
        `Error downloading image: ${error.message}`,
      );
    }
  }

  async convertToWav(input: string, output: string): Promise<void> {
    try {
      await execPromise(`ffmpeg -i "${input}" -ar 16000 -ac 1 "${output}" -y`);
    } catch (error) {
      throw new BadRequestException(
        `Error converting to WAV: ${(error as Error).message}`,
      );
    }
  }

  async audioToSrt(audioPath: string): Promise<string> {
    const path = await import('path');
    const fs = await import('fs/promises');

    const wavPath = audioPath.replace(/\.\w+$/, '.wav');
    const audioDir = path.dirname(audioPath);
    const audioBasename = path.basename(wavPath, '.wav');
    const srtPath = path.join(audioDir, `${audioBasename}.srt`);

    try {
      // Convert audio -> wav (chuẩn whisper)
      await this.convertToWav(audioPath, wavPath);

      // Run whisper
      await execPromise(
        `whisper "${wavPath}" --model tiny --output_format srt --output_dir "${audioDir}" --fp16 False`,
      );

      // Check file tồn tại
      await fs.access(srtPath);

      // Read async (nhanh hơn sync khi concurrent nhiều request)
      const srtContent = await fs.readFile(srtPath, 'utf-8');

      return srtContent;
    } catch (error) {
      throw new BadRequestException(
        `Audio → SRT error: ${(error as Error).message}`,
      );
    } finally {
      // Cleanup luôn (kể cả lỗi)
      try {
        await Promise.allSettled([
          fs.unlink(srtPath),
          fs.unlink(wavPath),
          fs.unlink(audioPath),
        ]);
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError);
      }
    }
  }

  downloadSrtFile(
    srtContent: string,
    originalFilename: string,
    res: Response,
  ): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { basename, extname } = require('path');

      // Generate filename from original audio filename
       
      const baseFilename = basename(
        originalFilename,
        extname(originalFilename),
      );
      const srtFilename = `${baseFilename}.srt`;

      // Set headers for download
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${srtFilename}"`,
      );
      res.setHeader('Content-Length', Buffer.byteLength(srtContent, 'utf-8'));

      // Send the file content directly
      res.send(srtContent);
    } catch (error) {
      throw new BadRequestException(
        `Error downloading SRT file: ${(error as Error).message}`,
      );
    }
  }

  srtToScript(srtContent: string): string {
    const parser = new SrtParser2();
    const blocks = parser.fromSrt(srtContent);
    return blocks
      .map((block: any) => block.text.trim())
      .filter((text: string) => text.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ');
  }

  /**
   * Set headers and send the raw script content as a downloadable .txt file.
   */
  downloadScriptFile(
    scriptContent: string,
    originalFilename: string,
    res: Response,
  ): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { basename, extname } = require('path');

      const baseFilename = basename(
        originalFilename,
        extname(originalFilename),
      );
      const txtFilename = `${baseFilename}.txt`;

      // Set headers for download
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${txtFilename}"`,
      );
      res.setHeader('Content-Length', Buffer.byteLength(scriptContent, 'utf-8'));

      // Send the file content directly
      res.send(scriptContent);
    } catch (error) {
      throw new BadRequestException(
        `Error downloading script file: ${(error as Error).message}`,
      );
    }
  }

  private shouldReencodeVideo(filePath: string): Promise<boolean> {
    return new Promise((resolve) => {
      Ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          console.warn('ffprobe error:', err);
          return resolve(true); // Default to safe path (re-encode)
        }
        const videoStream = metadata?.streams?.find((s) => s.codec_type === 'video');
        const audioStream = metadata?.streams?.find((s) => s.codec_type === 'audio');
        if (!videoStream) return resolve(true);

        const isH264 = videoStream.codec_name === 'h264';
        const hasAudio = !!audioStream;
        const isAac = hasAudio ? audioStream.codec_name === 'aac' : true;
        const isYuv420p = videoStream.pix_fmt === 'yuv420p';

        resolve(!(isH264 && isAac && isYuv420p));
      });
    });
  }

  // ──────────────────────────────────────────────────────────
  // YouTube OAuth2 & Channels Management (JSON storage)
  // ──────────────────────────────────────────────────────────

  /**
   * Đọc danh sách kênh đã liên kết từ file JSON
   */
  private readChannels(): YouTubeChannel[] {
    try {
      if (!fs.existsSync(this.channelsFilePath)) {
        return [];
      }
      const data = fs.readFileSync(this.channelsFilePath, 'utf-8');
      return JSON.parse(data) as YouTubeChannel[];
    } catch (error: any) {
      this.scheduleLogger.error(`Failed to read channels file: ${error.message}`);
      return [];
    }
  }

  /**
   * Ghi danh sách kênh đã liên kết vào file JSON
   */
  private writeChannels(channels: YouTubeChannel[]): void {
    try {
      fs.writeFileSync(this.channelsFilePath, JSON.stringify(channels, null, 2), 'utf-8');
    } catch (error: any) {
      this.scheduleLogger.error(`Failed to write channels file: ${error.message}`);
      throw new BadRequestException(`Failed to save channels storage: ${error.message}`);
    }
  }

  /**
   * Tạo OAuth2 client instance từ env
   */
  private createOAuth2Client() {
    const clientId =
      this.configService.get<string>('YOUTUBE_CLIENT_ID') ||
      this.configService.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret =
      this.configService.get<string>('YOUTUBE_CLIENT_SECRET') ||
      this.configService.get<string>('GOOGLE_CLIENT_SECRET');
    const redirectUri =
      this.configService.get<string>('YOUTUBE_REDIRECT_URI') ||
      this.configService.get<string>('GOOGLE_REDIRECT_URI') ||
      'http://localhost:3000/youtube/callback';

    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        'Missing YouTube/Google Client ID or Client Secret in environment variables.',
      );
    }

    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  /**
   * Sinh URL Authorization để Client chuyển hướng người dùng sang Google đăng nhập
   */
  getAuthUrl(): string {
    const oauth2Client = this.createOAuth2Client();

    const scopes = [
      'https://www.googleapis.com/auth/youtube.force-ssl',
      'https://www.googleapis.com/auth/youtube.readonly',
    ];

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent', // Luôn yêu cầu consent để nhận refresh_token mới
    });

    return url;
  }

  /**
   * Đổi Authorization Code lấy Tokens, gọi YouTube API lấy thông tin kênh, lưu vào channels.json và trả về refresh_token.
   */
  async handleCallback(code: string): Promise<string> {
    const oauth2Client = this.createOAuth2Client();

    // 1. Đổi Code lấy Tokens
    let tokens: any;
    try {
      const { tokens: t } = await oauth2Client.getToken(code);
      tokens = t;
    } catch (error: any) {
      const detail = error.response?.data?.error_description || error.message;
      this.scheduleLogger.error(`Failed to exchange auth code: ${JSON.stringify(error.response?.data)}`);
      throw new BadRequestException(`Failed to exchange Google authorization code: ${detail}`);
    }

    if (!tokens.refresh_token) {
      throw new BadRequestException(
        'No refresh_token received. Make sure to use prompt=consent and access_type=offline in the auth URL.',
      );
    }

    oauth2Client.setCredentials(tokens);

    // 2. Gọi YouTube API lấy thông tin kênh
    let channelData: any;
    try {
      const yt = google.youtube({ version: 'v3', auth: oauth2Client });
      const response = await yt.channels.list({
        part: ['snippet', 'contentDetails'],
        mine: true,
      });
      channelData = response.data.items?.[0];
    } catch (error: any) {
      const detail = error.response?.data?.error?.message || error.message;
      throw new BadRequestException(`Failed to fetch YouTube channel info: ${detail}`);
    }

    if (!channelData) {
      throw new BadRequestException('Could not retrieve channel information from YouTube.');
    }

    const channelId = channelData.id;
    const channelTitle = channelData.snippet?.title || channelId;
    const thumbnailUrl = channelData.snippet?.thumbnails?.default?.url || null;

    // 3. Lưu trữ kênh vào JSON
    const channels = this.readChannels();
    const existingIndex = channels.findIndex((ch) => ch.channelId === channelId);

    const newChannel: YouTubeChannel = {
      channelId,
      channelTitle,
      thumbnailUrl,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresAt: tokens.expiry_date || (Date.now() + 3600 * 1000),
      connectedAt: Date.now(),
    };

    if (existingIndex > -1) {
      channels[existingIndex] = newChannel;
      this.scheduleLogger.log(`Updated existing YouTube channel connection: ${channelTitle} (${channelId})`);
    } else {
      channels.push(newChannel);
      this.scheduleLogger.log(`Added new YouTube channel connection: ${channelTitle} (${channelId})`);
    }

    this.writeChannels(channels);

    return tokens.refresh_token;
  }

  /**
   * Đổi Authorization Code lấy Tokens, gọi YouTube API lấy thông tin kênh và lưu vào channels.json
   * (Method này được giữ lại để tương thích ngược)
   */
  async handleAuthCallback(code: string) {
    const oauth2Client = this.createOAuth2Client();

    // 1. Đổi Code lấy Tokens
    let tokens: any;
    try {
      const { tokens: t } = await oauth2Client.getToken(code);
      tokens = t;
    } catch (error: any) {
      const detail = error.response?.data?.error_description || error.message;
      this.scheduleLogger.error(`Failed to exchange auth code: ${JSON.stringify(error.response?.data)}`);
      throw new BadRequestException(`Failed to exchange Google authorization code: ${detail}`);
    }

    if (!tokens.refresh_token) {
      throw new BadRequestException(
        'No refresh_token received. Make sure to use prompt=consent and access_type=offline in the auth URL.',
      );
    }

    oauth2Client.setCredentials(tokens);

    // 2. Gọi YouTube API lấy thông tin kênh
    let channelData: any;
    try {
      const yt = google.youtube({ version: 'v3', auth: oauth2Client });
      const response = await yt.channels.list({
        part: ['snippet', 'contentDetails'],
        mine: true,
      });
      channelData = response.data.items?.[0];
    } catch (error: any) {
      const detail = error.response?.data?.error?.message || error.message;
      throw new BadRequestException(`Failed to fetch YouTube channel info: ${detail}`);
    }

    if (!channelData) {
      throw new BadRequestException('Could not retrieve channel information from YouTube.');
    }

    const channelId = channelData.id;
    const channelTitle = channelData.snippet?.title || channelId;
    const thumbnailUrl = channelData.snippet?.thumbnails?.default?.url || null;

    // 3. Lưu trữ kênh vào JSON
    const channels = this.readChannels();
    const existingIndex = channels.findIndex((ch) => ch.channelId === channelId);

    const newChannel: YouTubeChannel = {
      channelId,
      channelTitle,
      thumbnailUrl,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresAt: tokens.expiry_date || (Date.now() + 3600 * 1000),
      connectedAt: Date.now(),
    };

    if (existingIndex > -1) {
      channels[existingIndex] = newChannel;
      this.scheduleLogger.log(`Updated existing YouTube channel connection: ${channelTitle} (${channelId})`);
    } else {
      channels.push(newChannel);
      this.scheduleLogger.log(`Added new YouTube channel connection: ${channelTitle} (${channelId})`);
    }

    this.writeChannels(channels);

    return {
      success: true,
      message: 'YouTube channel connected successfully.',
      channel: {
        channelId: newChannel.channelId,
        channelTitle: newChannel.channelTitle,
        thumbnailUrl: newChannel.thumbnailUrl,
        connectedAt: newChannel.connectedAt,
      },
    };
  }

  /**
   * Lấy refresh token hợp lệ của Channel, tự động refresh access token nếu sắp/đã hết hạn
   */
  async getRefreshTokenForChannel(channelId: string): Promise<string> {
    const channels = this.readChannels();
    const channelIndex = channels.findIndex((ch) => ch.channelId === channelId);

    if (channelIndex === -1) {
      throw new NotFoundException(`YouTube channel "${channelId}" is not connected.`);
    }

    const channel = channels[channelIndex];

    // Auto-refresh access token nếu sắp hết hạn (buffer 5 phút)
    const BUFFER_TIME = 5 * 60 * 1000;
    if (Date.now() + BUFFER_TIME >= channel.expiresAt) {
      try {
        const oauth2Client = this.createOAuth2Client();
        oauth2Client.setCredentials({ refresh_token: channel.refreshToken });
        const { credentials } = await oauth2Client.refreshAccessToken();

        channel.accessToken = credentials.access_token || undefined;
        channel.expiresAt = credentials.expiry_date || (Date.now() + 3600 * 1000);

        // Google có thể trả refresh_token mới (hiếm khi)
        if (credentials.refresh_token) {
          channel.refreshToken = credentials.refresh_token;
        }

        channels[channelIndex] = channel;
        this.writeChannels(channels);
        this.scheduleLogger.log(`Refreshed access token for YouTube channel: ${channelId}`);
      } catch (err: any) {
        this.scheduleLogger.error(`Auto refresh token failed for ${channelId}: ${err.message}`);
        throw new BadRequestException(
          `YouTube token expired for "${channelId}" and refresh failed. Please re-authenticate.`,
        );
      }
    }

    return channel.refreshToken;
  }

  /**
   * Trả về danh sách kênh đã liên kết (Ẩn tokens)
   */
  getConnectedChannels() {
    const channels = this.readChannels();
    const sanitized = channels.map((ch) => ({
      channelId: ch.channelId,
      channelTitle: ch.channelTitle,
      thumbnailUrl: ch.thumbnailUrl,
      connectedAt: ch.connectedAt,
      expiresAt: ch.expiresAt,
      isExpired: Date.now() >= ch.expiresAt,
    }));

    return {
      success: true,
      count: sanitized.length,
      channels: sanitized,
    };
  }

  /**
   * Hủy kết nối kênh YouTube (Xóa khỏi JSON)
   */
  disconnectChannel(channelId: string) {
    const channels = this.readChannels();
    const filtered = channels.filter((ch) => ch.channelId !== channelId);

    if (channels.length === filtered.length) {
      throw new NotFoundException(`YouTube channel "${channelId}" was not found.`);
    }

    this.writeChannels(filtered);
    this.scheduleLogger.log(`Disconnected YouTube channel: ${channelId}`);

    return {
      success: true,
      message: `YouTube channel "${channelId}" has been disconnected.`,
    };
  }

  /**
   * Kiểm tra thủ công token có hoạt động hay không và còn bao nhiêu giây
   */
  async checkTokenStatus(channelId: string) {
    const channels = this.readChannels();
    const channel = channels.find((ch) => ch.channelId === channelId);

    if (!channel) {
      throw new NotFoundException(`YouTube channel "${channelId}" is not connected.`);
    }

    const isExpired = Date.now() >= channel.expiresAt;
    const timeLeftSeconds = Math.max(0, Math.floor((channel.expiresAt - Date.now()) / 1000));

    // Test call nhỏ tới YouTube API để kiểm tra token
    let isWorking = false;
    let errorMessage = '';

    try {
      const oauth2Client = this.createOAuth2Client();
      oauth2Client.setCredentials({ refresh_token: channel.refreshToken });

      // Nếu access token hết hạn, thử refresh trước
      if (isExpired) {
        const { credentials } = await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(credentials);
      } else if (channel.accessToken) {
        oauth2Client.setCredentials({
          refresh_token: channel.refreshToken,
          access_token: channel.accessToken,
        });
      }

      const yt = google.youtube({ version: 'v3', auth: oauth2Client });
      await yt.channels.list({ part: ['id'], mine: true });
      isWorking = true;
    } catch (error: any) {
      isWorking = false;
      errorMessage = error.response?.data?.error?.message || error.message;
    }

    return {
      success: true,
      channelId,
      channelTitle: channel.channelTitle,
      isExpired,
      timeLeftSeconds,
      isWorking,
      errorMessage: isWorking ? null : errorMessage,
    };
  }

  // ──────────────────────────────────────────────────────────
  // YouTube Data API v3: Scheduled Video Publishing
  // ──────────────────────────────────────────────────────────

  private readonly scheduleLogger = new Logger('YoutubeScheduler');

  /**
   * Lên lịch tự động public một video YouTube đang ở trạng thái Private.
   *
   * Cơ chế multi-channel (mô hình Pinterest):
   * - Mỗi kênh YouTube đã kết nối sẽ được lưu trong data/youtube/channels.json
   *   kèm refresh_token.
   * - Client chỉ cần gửi channelId — backend tự lookup refresh token từ JSON storage,
   *   khởi tạo OAuth2 client, và gọi YouTube Data API dưới danh nghĩa kênh tương ứng.
   * - Token sẽ được tự động refresh khi sắp hết hạn.
   *
   * YouTube sẽ tự động chuyển video sang "public" khi đến thời điểm publishAt.
   * Điều kiện: video phải đang ở trạng thái "private" (không phải "unlisted").
   */
  async scheduleVideo(dto: ScheduleYoutubeDto) {
    // Lấy refresh token từ storage (tự auto-refresh nếu sắp hết hạn)
    const refreshToken = await this.getRefreshTokenForChannel(dto.channelId);

    // Khởi tạo OAuth2 client với refresh token từ storage
    const oauth2Client = this.createOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    this.scheduleLogger.log(
      `Scheduling video "${dto.videoId}" on channel "${dto.channelId}" to publish at ${dto.publishTime}`,
    );

    try {
      // 1. Lấy thông tin video hiện tại để lấy categoryId gốc của nó
      const videoInfo = await youtube.videos.list({
        part: ['snippet'],
        id: [dto.videoId],
      });

      const currentVideo = videoInfo.data.items?.[0];
      if (!currentVideo) {
        throw new NotFoundException(`Video "${dto.videoId}" not found on YouTube.`);
      }

      const categoryId = currentVideo.snippet?.categoryId || '22'; // 22 là category mặc định "People & Blogs" làm fallback

      // 2. Thực hiện cập nhật thông tin và lên lịch video
      const response = await youtube.videos.update({
        part: ['snippet', 'status'],
        requestBody: {
          id: dto.videoId,
          snippet: {
            title: dto.title,
            description: dto.description,
            tags: dto.tags,
            categoryId: categoryId, // Truyền categoryId hiện tại để tránh lỗi API
          },
          status: {
            privacyStatus: 'private',
            publishAt: dto.publishTime,
            containsSyntheticMedia: dto.containsSyntheticMedia,
          },
        },
      });

      const video = response.data;

      this.scheduleLogger.log(
        `Video "${dto.videoId}" scheduled successfully. ` +
          `Title: "${video.snippet?.title}", ` +
          `Publish at: ${video.status?.publishAt}`,
      );

      return {
        success: true,
        videoId: video.id,
        title: video.snippet?.title,
        channelId: video.snippet?.channelId,
        channelTitle: video.snippet?.channelTitle,
        publishAt: video.status?.publishAt,
        privacyStatus: video.status?.privacyStatus,
      };
    } catch (error: any) {
      const status = error.response?.status || error.code;
      const message =
        error.response?.data?.error?.message ||
        error.errors?.[0]?.message ||
        error.message;

      this.scheduleLogger.error(
        `Failed to schedule video "${dto.videoId}": [${status}] ${message}`,
        error.stack,
      );

      throw new BadRequestException(
        `YouTube API error [${status}]: ${message}`,
      );
    }
  }

  /**
   * Lấy danh sách video của một kênh YouTube đã liên kết.
   *
   * Sử dụng Playlist "uploads" đặc biệt của kênh để duyệt qua toàn bộ video,
   * kể cả các video đang ở trạng thái Private hay Unlisted (thích hợp cho quản trị).
   */
  async getVideos(dto: GetChannelVideosApiDto) {
    const refreshToken = await this.getRefreshTokenForChannel(dto.channelId);
    const oauth2Client = this.createOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    try {
      // 1. Lấy thông tin uploads playlist ID của kênh
      const channelResponse = await youtube.channels.list({
        part: ['contentDetails'],
        id: [dto.channelId],
      });

      const channel = channelResponse.data.items?.[0];
      if (!channel) {
        throw new NotFoundException(`YouTube channel "${dto.channelId}" was not found on YouTube.`);
      }

      const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
      if (!uploadsPlaylistId) {
        throw new BadRequestException(`Could not retrieve uploads playlist for channel ${dto.channelId}.`);
      }

      // 2. Lấy danh sách video sơ bộ từ playlist uploads
      const playlistResponse = await youtube.playlistItems.list({
        part: ['snippet', 'status', 'contentDetails'],
        playlistId: uploadsPlaylistId,
        maxResults: dto.maxResults || 10,
        pageToken: dto.pageToken,
      });

      const items = playlistResponse.data.items || [];
      const videoIds = items.map((item) => item.contentDetails?.videoId).filter(Boolean) as string[];

      // 3. Gọi thêm Videos.list để lấy thông tin chi tiết trạng thái lên lịch (publishAt)
      let detailedVideosMap = new Map<string, any>();
      if (videoIds.length > 0) {
        try {
          const videosResponse = await youtube.videos.list({
            part: ['status', 'liveStreamingDetails', 'snippet'],
            id: videoIds,
          });
          const detailedItems = videosResponse.data.items || [];
          detailedItems.forEach((v) => {
            if (v.id) detailedVideosMap.set(v.id, v);
          });
        } catch (err) {
          this.scheduleLogger.warn(`Failed to fetch detailed video status: ${err.message}`);
        }
      }

      // 4. Map gộp dữ liệu từ playlistItems và videos.list
      let videos = items.map((item) => {
        const snippet = item.snippet;
        const status = item.status;
        const contentDetails = item.contentDetails;
        const videoId = contentDetails?.videoId || item.id || '';

        // Dữ liệu chi tiết lấy từ videos.list
        const detailedVideo = detailedVideosMap.get(videoId);

        // publishAt là thời gian lên lịch công chiếu chuyển từ Private -> Public
        const publishAt = detailedVideo?.status?.publishAt || null;

        // scheduledStartTime là thời gian lên lịch phát dưới dạng Premiere công chiếu trực tiếp
        const scheduledStartTime = detailedVideo?.liveStreamingDetails?.scheduledStartTime || null;

        return {
          id: videoId,
          title: snippet?.title || '',
          description: snippet?.description || '',
          thumbnailUrl:
            snippet?.thumbnails?.maxres?.url ||
            snippet?.thumbnails?.standard?.url ||
            snippet?.thumbnails?.high?.url ||
            snippet?.thumbnails?.medium?.url ||
            snippet?.thumbnails?.default?.url ||
            null,
          publishedAt: contentDetails?.videoPublishedAt || snippet?.publishedAt || null,
          privacyStatus: detailedVideo?.status?.privacyStatus || status?.privacyStatus || 'unknown',
          publishAt: publishAt, // Thời gian hẹn giờ public (Lịch công chiếu)
          scheduledStartTime: scheduledStartTime, // Thời gian hẹn Premiere (nếu có)
          raw: {
            ...item,
            detailedStatus: detailedVideo?.status || null,
            liveStreamingDetails: detailedVideo?.liveStreamingDetails || null,
          },
        };
      });

      // Lọc theo trạng thái quyền riêng tư nếu được truyền vào
      if (dto.privacyStatus) {
        const filterStatus = dto.privacyStatus.toLowerCase();
        videos = videos.filter((v) => v.privacyStatus === filterStatus);
      }

      return {
        success: true,
        channelId: dto.channelId,
        totalResults: playlistResponse.data.pageInfo?.totalResults || 0,
        resultsPerPage: playlistResponse.data.pageInfo?.resultsPerPage || 0,
        nextPageToken: playlistResponse.data.nextPageToken || null,
        prevPageToken: playlistResponse.data.prevPageToken || null,
        videos,
      };
    } catch (error: any) {
      const status = error.response?.status || error.code;
      const message =
        error.response?.data?.error?.message ||
        error.errors?.[0]?.message ||
        error.message;

      this.scheduleLogger.error(
        `Failed to fetch videos for channel "${dto.channelId}": [${status}] ${message}`,
        error.stack,
      );

      throw new BadRequestException(
        `YouTube API error [${status}]: ${message}`,
      );
    }
  }

  /**
   * Cập nhật ảnh thumbnail cho video YouTube bằng file upload trực tiếp
   */
  async updateThumbnail(dto: UploadThumbnailDto, file?: Express.Multer.File) {
    const { channelId, videoId } = dto;

    if (!file) {
      throw new BadRequestException('Vui lòng tải lên file ảnh làm thumbnail.');
    }

    let imageBuffer: Buffer;
    let mimeType = 'image/jpeg';
    const tempFilePathToDelete = file.path;

    try {
      // 1. Kiểm tra và đọc file upload
      if (!fs.existsSync(file.path)) {
        throw new BadRequestException('File tải lên không tồn tại trên server.');
      }

      const stats = fs.statSync(file.path);
      if (stats.size > 2 * 1024 * 1024) {
        throw new BadRequestException('Dung lượng ảnh thumbnail phải nhỏ hơn 2MB.');
      }

      mimeType = file.mimetype;
      imageBuffer = fs.readFileSync(file.path);

      // 2. Khởi tạo YouTube API client đã xác thực cho kênh
      const refreshToken = await this.getRefreshTokenForChannel(channelId);
      const oauth2Client = this.createOAuth2Client();
      oauth2Client.setCredentials({ refresh_token: refreshToken });
      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

      this.scheduleLogger.log(`Đang tải ảnh thumbnail lên video "${videoId}" của kênh "${channelId}"`);

      // Chuyển buffer thành readable stream để googleapis xử lý upload
      const stream = new Readable({
        read() {
          this.push(imageBuffer);
          this.push(null);
        },
      });

      // 3. Gọi API thumbnails.set của YouTube Data API v3
      const apiResponse = await youtube.thumbnails.set({
        videoId,
        media: {
          mimeType,
          body: stream,
        },
      });

      this.scheduleLogger.log(`Đã cập nhật thumbnail thành công cho video "${videoId}"`);

      return {
        success: true,
        videoId,
        channelId,
        thumbnailUrl: apiResponse.data.items?.[0]?.default?.url || null,
        data: apiResponse.data,
      };

    } catch (error: any) {
      const status = error.response?.status || error.code || 500;
      const message =
        error.response?.data?.error?.message ||
        error.errors?.[0]?.message ||
        error.message;

      this.scheduleLogger.error(
        `Lỗi khi cập nhật thumbnail cho video "${videoId}": [${status}] ${message}`,
        error.stack,
      );

      throw new BadRequestException(`Lỗi YouTube API [${status}]: ${message}`);
    } finally {
      // 4. Dọn dẹp file upload tạm trên server
      if (tempFilePathToDelete && fs.existsSync(tempFilePathToDelete)) {
        try {
          fs.unlinkSync(tempFilePathToDelete);
        } catch (cleanupError: any) {
          this.scheduleLogger.warn(`Không thể xóa file tạm ${tempFilePathToDelete}: ${cleanupError.message}`);
        }
      }
    }
  }
}

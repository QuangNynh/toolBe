/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { Response } from 'express';
import pLimit from 'p-limit';
import { exec as youtubeDlExec } from 'youtube-dl-exec';
import { fetchTranscript } from 'youtube-transcript-plus';
import { Innertube } from 'youtubei.js';
import type VideoInfo from 'youtubei.js/dist/src/parser/youtube/VideoInfo';
import axios from 'axios';
import * as sharp from 'sharp';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);


@Injectable()
export class YoutubeService implements OnModuleInit {
  private youtube: Innertube;

  async onModuleInit() {
    this.youtube = await Innertube.create();
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
      } catch (err:any) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        lastError = error;
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    return {
      success: false,
      videoId,
      transcript: null,
      transcriptLanguage: null,
      metadata: null,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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
    return filename
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
      .substring(0, 200) || 'audio'; // Limit length and provide fallback
  }

  async streamAudio(url: string, res: Response) {
    try {
      // Extract video ID to get metadata
      let videoId: string;
      if (url.includes('v=')) {
        videoId = url.split('v=')[1].split('&')[0];
      } else {
        const parts = url.split('/');
        videoId = parts[parts.length - 1] || '';
      }

      let filename = 'audio.mp3';
      if (videoId) {
        try {
          const info = await this.youtube.getInfo(videoId);
          const sanitizedTitle = this.sanitizeFilename(info.basic_info.title || 'audio');
          filename = `${sanitizedTitle}.mp3`;
        } catch {
          // If can't get info, use default filename
        }
      }

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );

      const subprocess = youtubeDlExec(url, {
        extractAudio: true,
        audioFormat: 'mp3',
        output: '-',
      });

      if (!subprocess.stdout) {
        throw new BadRequestException('Could not create audio stream');
      }

      subprocess.stdout.pipe(res);

      if (subprocess.stderr) {
        subprocess.stderr.on('data', (err) => {
          console.error(err.toString());
        });
      }
    } catch (error) {
      throw new BadRequestException(`Error streaming audio: ${error.message}`);
    }
  }


 async getChannelVideos(url: string) {
  try {
    const result = await youtubeDlExec(url , {
      dumpSingleJson: true,
      flatPlaylist: true,
    });

    if (!result) {
      throw new BadRequestException('No data returned from youtube-dl');
    }

    const parsed = JSON.parse(result.stdout) as { entries: Array<{
      id?: string;
      url?: string;
      title?: string;
      description?: string;
      duration?: number;
      view_count?: number;
    }> };

    return parsed.entries.map((item) => ({
      id: item?.id,
      url: item?.url,
      title: item?.title,
      description: item?.description,
      duration: item?.duration,
      view_count: item?.view_count
    }));
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
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
      
      if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        contentType = 'image/jpeg';
        extension = 'jpg';
      } else if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        contentType = 'image/png';
        extension = 'png';
      } else if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
        contentType = 'image/gif';
        extension = 'gif';
      } else if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
        // WebP detected - convert to JPG for Canva compatibility
        needsConversion = true;
        contentType = 'image/jpeg';
        extension = 'jpg';
      }

      // Convert WebP to JPG if needed
      if (needsConversion) {
        console.log('Converting WebP to JPG for Canva compatibility...');
        buffer = await sharp(buffer)
          .jpeg({ quality: 95 })
          .toBuffer();
      }
      
      // Extract filename from URL
      const urlParts = imageUrl.split('/');
      const urlFilename = urlParts[urlParts.length - 1].split('?')[0].split('.')[0];
      const sanitizedFilename = this.sanitizeFilename(urlFilename || 'image');
      const filename = `${sanitizedFilename}.${extension}`;

      console.log(`Downloading image: ${filename}, size: ${buffer.length} bytes, type: ${contentType}`);

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', buffer.length.toString());
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
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
      await execPromise(
        `ffmpeg -i "${input}" -ar 16000 -ac 1 "${output}" -y`
      );
    } catch (error) {
      throw new BadRequestException(
        `Error converting to WAV: ${(error as Error).message}`,
      );
    }
  }

  async audioToSrt(audioPath: string): Promise<string> {
    try {
      const path = await import('path');
      const fs = await import('fs');
      
      const wavPath = audioPath.replace(/\.\w+$/, '.wav');
      const audioDir = path.dirname(audioPath);
      const audioBasename = path.basename(wavPath, '.wav');

      await this.convertToWav(audioPath, wavPath);

      // Whisper creates the SRT file in the same directory as the input file
      // with the same basename
      await execPromise(
        `whisper "${wavPath}" --model base --output_format srt --output_dir "${audioDir}"`
      );

      // The SRT file will be created with the same name as the wav file
      const srtPath = path.join(audioDir, `${audioBasename}.srt`);

      // Check if file was created
      if (!fs.existsSync(srtPath)) {
        throw new Error(`SRT file not created at expected path: ${srtPath}`);
      }

      // Read SRT content
      const srtContent = fs.readFileSync(srtPath, 'utf-8');

      // Clean up all files immediately after reading
      try {
        if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
        if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      } catch (cleanupError) {
        console.error('Error cleaning up files:', cleanupError);
      }

      return srtContent;
    } catch (error) {
      throw new BadRequestException(
        `Error converting audio to SRT: ${(error as Error).message}`,
      );
    }
  }

  async downloadSrtFile(srtContent: string, originalFilename: string, res: Response): Promise<void> {
    try {
      const path = await import('path');

      // Generate filename from original audio filename
      const baseFilename = path.basename(originalFilename, path.extname(originalFilename));
      const srtFilename = `${baseFilename}.srt`;

      // Set headers for download
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${srtFilename}"`);
      res.setHeader('Content-Length', Buffer.byteLength(srtContent, 'utf-8'));

      // Send the file content directly
      res.send(srtContent);
    } catch (error) {
      throw new BadRequestException(
        `Error downloading SRT file: ${(error as Error).message}`,
      );
    }
  }
  
}

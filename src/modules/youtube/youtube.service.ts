import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { Response } from 'express';
import pLimit from 'p-limit';
import { exec as youtubeDlExec } from 'youtube-dl-exec';
import { fetchTranscript } from 'youtube-transcript-plus';
import { Innertube } from 'youtubei.js';
import axios from 'axios';
import * as sharp from 'sharp';

@Injectable()
export class YoutubeService implements OnModuleInit {
  private youtube: Innertube;

  async onModuleInit() {
    this.youtube = await Innertube.create();
  }

  /* ---------------- METADATA BUILDER ---------------- */
  private buildMetadata(info: any, videoId: string) {
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
      } catch (err) {
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
    }) as any;


    if (!result) {
      throw new BadRequestException('No data returned from youtube-dl');
    }

    return  JSON.parse(result.stdout).entries.map((item:any)=>({
      id: item?.id,
      url: item?.url,
      title: item?.title,
      description: item?.description ,
      duration: item?.duration,
      view_count: item?.view_count
    }));
  } catch (error) {
    throw new BadRequestException(
      `Error fetching channel videos: ${error.message}`,
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
  
}

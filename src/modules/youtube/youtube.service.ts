import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { Response } from 'express';
import pLimit from 'p-limit';
import { exec as youtubeDlExec } from 'youtube-dl-exec';
import { fetchTranscript } from 'youtube-transcript-plus';
import { Innertube } from 'youtubei.js';
import axios from 'axios';

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
          filename = `${info.basic_info.title}.mp3`;
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
        responseType: 'stream',
        timeout: 30000,
      });

      const contentType = response.headers['content-type'] || 'image/jpeg';
      const extension = contentType.split('/')[1] || 'jpg';
      
      // Extract filename from URL or use default
      const urlParts = imageUrl.split('/');
      const urlFilename = urlParts[urlParts.length - 1].split('?')[0];
      const filename = urlFilename || `image.${extension}`;

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      response.data.pipe(res);
    } catch (error) {
      throw new BadRequestException(
        `Error downloading image: ${error.message}`,
      );
    }
  }
  
}

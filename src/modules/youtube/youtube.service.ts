import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import pLimit from 'p-limit';
import { fetchTranscript } from 'youtube-transcript-plus';
import { Innertube } from 'youtubei.js';

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
}

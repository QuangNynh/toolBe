import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
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
      };
    } catch (error) {
      return {
        success: false,
        videoId,
        transcript: null,
        transcriptLanguage: null,
        metadata: null,
        error: error.message,
      };
    }
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
  async getTranscripts(videoIds: string[], preferredLang = 'vi') {
    return Promise.all(
      videoIds.map((id) => this.getTranscript(id, preferredLang)),
    );
  }
}

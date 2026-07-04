/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { exec as youtubeDlExec } from 'youtube-dl-exec';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

// Set FFmpeg binary path from the bundled installer
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

@Injectable()
export class TiktokService {
  private readonly logger = new Logger(TiktokService.name);

  async getChannelVideos(url: string, limitVal?: number) {
    try {
      this.logger.log(
        `Fetching TikTok videos from: ${url}` +
          (limitVal ? ` (limit: ${limitVal})` : ' (all videos)'),
      );

      const options: any = {
        dumpSingleJson: true,
        flatPlaylist: true,
        noWarnings: true,
        noCheckCertificates: true,
      };

      if (limitVal !== undefined && limitVal > 0) {
        options.playlistItems = `1-${limitVal}`;
      }

      const result = await youtubeDlExec(url, options);

      if (!result || !result.stdout) {
        throw new BadRequestException('No data returned from yt-dlp');
      }

      const parsed = JSON.parse(result.stdout);
      const rawEntries: any[] = parsed.entries ?? [parsed];

      const videos = rawEntries
        .filter((entry) => entry)
        .map((entry) => {
          const timestamp = entry.timestamp;
          const createdAt = timestamp
            ? new Date(timestamp * 1000).toISOString()
            : null;

          return {
            id: entry.id ?? null,
            title: entry.title ?? null,
            description: entry.description ?? null,
            url: entry.url ?? `https://www.tiktok.com/@${parsed.title}/video/${entry.id}`,
            duration: entry.duration ?? null,
            view_count: Number(entry.view_count ?? 0),
            like_count: Number(entry.like_count ?? 0),
            comment_count: Number(entry.comment_count ?? 0),
            repost_count: Number(entry.repost_count ?? 0),
            save_count: Number(entry.save_count ?? 0),
            created_at: createdAt,
            uploader: entry.uploader ?? parsed.title ?? null,
            uploader_id: entry.uploader_id ?? null,
            thumbnails: entry.thumbnails ?? [],
          };
        });

      return {
        channel: parsed.title ?? null,
        title: parsed.title ?? null,
        url: parsed.webpage_url ?? url,
        video_count: videos.length,
        videos,
      };
    } catch (error: any) {
      const msg = error.message || String(error);
      this.logger.error(`Failed to fetch TikTok videos: ${msg}`, error);
      throw new BadRequestException(`Failed to fetch TikTok videos: ${msg}`);
    }
  }

  async downloadVideo(url: string, res: Response) {
    let rawFile: string | null = null;
    let finalFile: string | null = null;
    try {
      this.logger.log(`Fetching metadata for TikTok video: ${url}`);
      
      // Step 1: Fetch metadata for title
      let title = 'tiktok_video';
      try {
        const metaResult = await youtubeDlExec(url, {
          dumpSingleJson: true,
          noWarnings: true,
          noCheckCertificates: true,
        });
        if (metaResult && metaResult.stdout) {
          const meta = JSON.parse(metaResult.stdout);
          if (meta.title) {
            title = meta.title;
          } else if (meta.description) {
            title = meta.description;
          }
        }
      } catch (err: any) {
        this.logger.warn(`Failed to fetch metadata: ${err.message}. Using default filename.`);
      }

      const sanitizedTitle = this.sanitizeFilename(title).substring(0, 50) || 'tiktok_video';
      const filename = `${sanitizedTitle}.mp4`;

      // Setup temp files
      const tempDir = os.tmpdir();
      rawFile = path.join(tempDir, `tiktok-${Date.now()}-raw.mp4`);
      finalFile = path.join(tempDir, `tiktok-${Date.now()}-final.mp4`);

      this.logger.log(`Downloading TikTok video from: ${url} to ${rawFile}`);

      // Step 2: Download video
      await youtubeDlExec(url, {
        format: 'best',
        output: rawFile,
        noCheckCertificates: true,
        noWarnings: true,
      });

      if (!fs.existsSync(rawFile)) {
        throw new BadRequestException('Downloaded file does not exist');
      }

      this.logger.log(`Download complete, re-encoding for compatibility...`);

      // Step 3: Re-encode with ffmpeg for CapCut/Media Player compatibility
      const inputPath = rawFile;
      const outputPath = finalFile;
      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .videoCodec('libx264')
          .audioCodec('aac')
          .outputOptions([
            '-movflags +faststart', // Enable fast start
            '-preset fast', // Fast encoding
            '-crf 23', // Quality (lower = better, 23 is good)
            '-pix_fmt yuv420p', // Pixel format for maximum player compatibility
          ])
          .save(outputPath)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err));
      });

      // Delete raw file
      try {
        fs.unlinkSync(rawFile);
      } catch {
        // Ignore
      }
      rawFile = null;

      if (!fs.existsSync(finalFile)) {
        throw new BadRequestException('Processed file does not exist');
      }

      this.logger.log(`Re-encoding complete, streaming ${filename} to client...`);

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

      // Stream the file
      const stream = fs.createReadStream(finalFile);
      stream.pipe(res);

      // Cleanup after streaming completes
      const targetFile = finalFile;
      res.on('finish', () => {
        fs.unlink(targetFile, (err) => {
          if (err) console.error('Cleanup error:', err);
        });
      });

      // Cleanup on error
      stream.on('error', (error) => {
        console.error('Stream error:', error);
        fs.unlink(targetFile, () => {});
      });

    } catch (error: any) {
      if (rawFile && fs.existsSync(rawFile)) {
        try {
          fs.unlinkSync(rawFile);
        } catch {
          // Ignore cleanup errors
        }
      }
      if (finalFile && fs.existsSync(finalFile)) {
        try {
          fs.unlinkSync(finalFile);
        } catch {
          // Ignore cleanup errors
        }
      }
      const msg = error.message || String(error);
      this.logger.error(`Failed to download TikTok video: ${msg}`, error);
      throw new BadRequestException(`Failed to download TikTok video: ${msg}`);
    }
  }

  async downloadAudio(url: string, res: Response) {
    try {
      this.logger.log(`Fetching metadata for TikTok audio: ${url}`);
      
      // Step 1: Fetch metadata for title
      let title = 'tiktok_audio';
      try {
        const metaResult = await youtubeDlExec(url, {
          dumpSingleJson: true,
          noWarnings: true,
          noCheckCertificates: true,
        });
        if (metaResult && metaResult.stdout) {
          const meta = JSON.parse(metaResult.stdout);
          if (meta.title) {
            title = meta.title;
          } else if (meta.description) {
            title = meta.description;
          }
        }
      } catch (err: any) {
        this.logger.warn(`Failed to fetch metadata: ${err.message}. Using default filename.`);
      }

      const sanitizedTitle = this.sanitizeFilename(title).substring(0, 50) || 'tiktok_audio';
      const filename = `${sanitizedTitle}.mp3`;

      // Set headers for download
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );

      // Step 2: Stream audio using yt-dlp stdout pipe
      const subprocess = youtubeDlExec(url, {
        extractAudio: true,
        audioFormat: 'mp3',
        audioQuality: 0, // best audio quality
        format: 'bestaudio/best', // force audio-only format
        output: '-',
        noCheckCertificates: true,
        noWarnings: true,
      });

      if (!subprocess.stdout) {
        throw new BadRequestException('Could not create audio stream');
      }

      subprocess.stdout.pipe(res);

      if (subprocess.stderr) {
        subprocess.stderr.on('data', (err) => {
          this.logger.error(`yt-dlp stderr: ${err.toString()}`);
        });
      }
    } catch (error: any) {
      const msg = error.message || String(error);
      this.logger.error(`Failed to stream TikTok audio: ${msg}`, error);
      throw new BadRequestException(`Failed to stream TikTok audio: ${msg}`);
    }
  }

  private sanitizeFilename(name: string): string {
    return name
      .replace(/[^a-zA-Z0-9\s-_]/g, '') // Keep alphanumeric, spaces, hyphens, underscores
      .trim()
      .replace(/\s+/g, '_'); // Replace spaces with underscores
  }
}

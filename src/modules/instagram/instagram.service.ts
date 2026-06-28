import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Response } from 'express';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { MediaService } from '../media/media.service';
import { ProxyService } from '../proxy/proxy.service';

export interface InstagramResponse {
  results_number: number;
  url_list: string[];
  post_info: {
    owner_username: string;
    owner_fullname: string;
    is_verified: boolean;
    is_private: boolean;
    likes: number;
    is_ad: boolean;
    caption: string;
  };
  media_details: {
    type: string;
    dimensions: {
      height: number;
      width: number;
    };
    url: string;
    video_view_count?: number;
    thumbnail?: string;
  }[];
}

@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);

  constructor(
    private readonly mediaService: MediaService,
    private readonly proxyService: ProxyService,
  ) {}

  /**
   * Helper to extract the shortcode from an Instagram URL or use it directly if it's already an ID
   */
  private getShortcode(input: string): string {
    const trimmed = input.trim();

    // If it looks like a full URL (contains slashes or instagram.com)
    if (trimmed.includes('/') || trimmed.includes('instagram.com')) {
      const match = trimmed.match(/(?:\/p\/|\/reel\/|\/tv\/|\/reels\/)([A-Za-z0-9_-]+)/);
      if (!match) {
        throw new BadRequestException('Invalid Instagram URL. Only posts and reels are supported.');
      }
      return match[1];
    }

    // Otherwise, validate if it matches the format of a shortcode (alphanumeric, dashes, underscores)
    if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
      throw new BadRequestException('Invalid Instagram shortcode or URL format.');
    }
    return trimmed;
  }

  /**
   * Fetches Instagram landing page to extract CSRF token and Cookie headers.
   * Fixes the library bug where it only checked the first cookie.
   */
  private async getCSRFTokenAndCookies(agent?: any): Promise<{ csrfToken: string; cookieHeader: string }> {
    try {
      const response = await axios.request({
        method: 'GET',
        url: 'https://www.instagram.com/',
        httpsAgent: agent,
        httpAgent: agent,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      const setCookies = response.headers['set-cookie'];
      if (!setCookies || setCookies.length === 0) {
        throw new Error('No set-cookie headers returned from Instagram.');
      }

      let csrfToken = '';
      const cookieParts: string[] = [];

      for (const cookie of setCookies) {
        const parts = cookie.split(';');
        const firstPart = parts[0];
        cookieParts.push(firstPart);

        if (firstPart.startsWith('csrftoken=')) {
          csrfToken = firstPart.replace('csrftoken=', '');
        }
      }

      // Fallback: search for csrftoken in all cookie strings
      if (!csrfToken) {
        for (const cookie of setCookies) {
          const match = cookie.match(/csrftoken=([^;]+)/);
          if (match) {
            csrfToken = match[1];
            break;
          }
        }
      }

      if (!csrfToken) {
        throw new Error('CSRF token not found in set-cookie headers.');
      }

      return {
        csrfToken,
        cookieHeader: cookieParts.join('; '),
      };
    } catch (err: any) {
      throw new Error(`Failed to obtain CSRF: ${err.message}`);
    }
  }

  /**
   * Custom request to Instagram GraphQL query API with detailed error logging
   */
  private async queryInstagramGraphQL(
    shortcode: string,
    csrfToken: string,
    cookieHeader: string,
    agent?: any,
  ): Promise<any> {
    const BASE_URL = 'https://www.instagram.com/graphql/query';
    const INSTAGRAM_DOCUMENT_ID = '10015901848480474';

    const postData = new URLSearchParams({
      variables: JSON.stringify({
        shortcode,
        fetch_tagged_user_count: null,
        hoisted_comment_id: null,
        hoisted_reply_id: null,
      }),
      doc_id: INSTAGRAM_DOCUMENT_ID,
    });

    try {
      const response = await axios.request({
        method: 'POST',
        url: BASE_URL,
        httpsAgent: agent,
        httpAgent: agent,
        headers: {
          'X-CSRFToken': csrfToken,
          'Cookie': cookieHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': `https://www.instagram.com/reel/${shortcode}/`,
          'Origin': 'https://www.instagram.com',
        },
        data: postData.toString(),
      });

      const data = response.data;
      
      if (!data || !data.data || !data.data.xdt_shortcode_media) {
        this.logger.error(`GraphQL query returned empty or invalid data. Raw response: ${JSON.stringify(data)}`);
        throw new Error('Only posts/reels supported, or post is private/unavailable.');
      }

      return data.data.xdt_shortcode_media;
    } catch (err: any) {
      if (err.response) {
        this.logger.error(
          `GraphQL HTTP Error ${err.response.status}: ${JSON.stringify(err.response.data)}`,
        );
      } else {
        this.logger.error(`GraphQL Connection/Request Error: ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Formats the GraphQL raw response into InstagramResponse
   */
  private formatInstagramResponse(requestData: any): InstagramResponse {
    const url_list: string[] = [];
    const media_details: any[] = [];

    const isSidecar = requestData['__typename'] === 'XDTGraphSidecar';

    if (isSidecar) {
      const edges = requestData.edge_sidecar_to_children?.edges || [];
      for (const edge of edges) {
        const node = edge.node;
        if (node) {
          media_details.push(this.formatMediaDetails(node));
          url_list.push(node.is_video ? node.video_url : node.display_url);
        }
      }
    } else {
      media_details.push(this.formatMediaDetails(requestData));
      url_list.push(requestData.is_video ? requestData.video_url : requestData.display_url);
    }

    const caption = requestData.edge_media_to_caption?.edges?.[0]?.node?.text || '';

    return {
      results_number: url_list.length,
      url_list,
      post_info: {
        owner_username: requestData.owner?.username || '',
        owner_fullname: requestData.owner?.full_name || '',
        is_verified: !!requestData.owner?.is_verified,
        is_private: !!requestData.owner?.is_private,
        likes: requestData.edge_media_preview_like?.count || 0,
        is_ad: !!requestData.is_ad,
        caption,
      },
      media_details,
    };
  }

  private formatMediaDetails(mediaData: any) {
    if (mediaData.is_video) {
      return {
        type: 'video',
        dimensions: mediaData.dimensions || { height: 0, width: 0 },
        video_view_count: mediaData.video_view_count || 0,
        url: mediaData.video_url,
        thumbnail: mediaData.display_url,
      };
    } else {
      return {
        type: 'image',
        dimensions: mediaData.dimensions || { height: 0, width: 0 },
        url: mediaData.display_url,
      };
    }
  }

  /**
   * Custom Fetch implementation mimicking library but with fixes.
   */
  private async fetchInstagramDataCustom(url: string, agent?: any): Promise<InstagramResponse> {
    const shortcode = this.getShortcode(url);
    this.logger.log(`Fetching metadata for shortcode: ${shortcode}`);

    // 1. Get CSRF token and Cookies
    const { csrfToken, cookieHeader } = await this.getCSRFTokenAndCookies(agent);
    
    // 2. Query Instagram GraphQL
    const mediaData = await this.queryInstagramGraphQL(shortcode, csrfToken, cookieHeader, agent);

    // 3. Format into InstagramResponse
    return this.formatInstagramResponse(mediaData);
  }

  /**
   * Helper to retrieve Instagram post data.
   * Tries to use the configured proxy first, and falls back to a direct connection if it fails.
   */
  private async getInstagramData(url: string): Promise<InstagramResponse> {
    const proxyUrl = this.proxyService.getProxyUrl();
    const agent = new HttpsProxyAgent(proxyUrl);

    // 1. Try with proxy first
    try {
      this.logger.log(`Attempting to fetch Instagram metadata using proxy: ${proxyUrl}`);
      return await this.fetchInstagramDataCustom(url, agent);
    } catch (proxyError: any) {
      this.logger.warn(
        `Proxy request failed (${proxyError.message}). Retrying with direct connection...`
      );
    }

    // 2. Fallback to direct request
    try {
      this.logger.log(`Fetching Instagram metadata directly (no proxy) for URL: ${url}`);
      return await this.fetchInstagramDataCustom(url);
    } catch (directError: any) {
      this.logger.error(`Direct connection failed: ${directError.message}`);
      throw new BadRequestException(
        `Failed to parse Instagram URL: ${directError.message}`
      );
    }
  }

  /**
   * Fetches Instagram video metadata and returns a clean info object
   */
  async getVideoInfo(url: string) {
    const data = await this.getInstagramData(url);

    if (!data || !data.media_details || data.media_details.length === 0) {
      throw new BadRequestException('Cannot retrieve media details from this Instagram URL');
    }

    // Find the first video in media_details
    const videoMedia = data.media_details.find((m) => m.type === 'video');
    if (!videoMedia) {
      throw new BadRequestException('No video found in this Instagram post');
    }

    const username = data.post_info?.owner_username || 'instagram';

    return {
      success: true,
      title: data.post_info?.caption || 'Instagram Video',
      username,
      fullname: data.post_info?.owner_fullname,
      likes: data.post_info?.likes,
      isVerified: data.post_info?.is_verified,
      videoUrl: videoMedia.url,
      thumbnailUrl: videoMedia.thumbnail || '',
      width: videoMedia.dimensions?.width,
      height: videoMedia.dimensions?.height,
      views: videoMedia.video_view_count,
      resultsNumber: data.results_number,
    };
  }

  /**
   * Streams the Instagram video directly to the Express Response
   */
  async downloadVideo(url: string, res: Response) {
    const data = await this.getInstagramData(url);

    if (!data || !data.media_details || data.media_details.length === 0) {
      throw new BadRequestException('Cannot retrieve media details from this Instagram URL');
    }

    const videoMedia = data.media_details.find((m) => m.type === 'video');
    if (!videoMedia) {
      throw new BadRequestException('No video found in this Instagram post');
    }

    const videoUrl = videoMedia.url;
    const username = data.post_info?.owner_username || 'instagram';
    const filename = `instagram_${username}_${Date.now()}.mp4`;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // 1. Try streaming with proxy
    try {
      const proxyUrl = this.proxyService.getProxyUrl();
      this.logger.log(`Attempting to stream video using proxy...`);
      const agent = new HttpsProxyAgent(proxyUrl);
      const response = await axios({
        url: videoUrl,
        method: 'GET',
        responseType: 'stream',
        httpsAgent: agent,
        httpAgent: agent,
        headers: this.getDownloadHeaders(),
      });
      response.data.pipe(res);
      return;
    } catch (proxyError: any) {
      this.logger.warn(`Failed to stream video using proxy: ${proxyError.message}. Retrying direct download...`);
    }

    // 2. Fallback to direct stream
    try {
      this.logger.log(`Streaming video directly to client...`);
      const response = await axios({
        url: videoUrl,
        method: 'GET',
        responseType: 'stream',
        headers: this.getDownloadHeaders(),
      });
      response.data.pipe(res);
    } catch (directError: any) {
      this.logger.error(`Direct video download failed: ${directError.message}`);
      throw new BadRequestException(`Could not stream video: ${directError.message}`);
    }
  }

  /**
   * Downloads the Instagram video, extracts its audio, and streams the MP3
   */
  async downloadAudio(url: string, res: Response) {
    const data = await this.getInstagramData(url);

    if (!data || !data.media_details || data.media_details.length === 0) {
      throw new BadRequestException('Cannot retrieve media details from this Instagram URL');
    }

    const videoMedia = data.media_details.find((m) => m.type === 'video');
    if (!videoMedia) {
      throw new BadRequestException('No video found in this Instagram post');
    }

    const videoUrl = videoMedia.url;
    const username = data.post_info?.owner_username || 'instagram';

    const tempDir = os.tmpdir();
    const baseName = `ig-video-${Date.now()}`;
    const tempVideoPath = path.join(tempDir, `${baseName}.mp4`);

    this.logger.log(`Downloading temporary video file to: ${tempVideoPath}`);

    let downloaded = false;
    
    // 1. Try downloading with proxy first
    try {
      const proxyUrl = this.proxyService.getProxyUrl();
      this.logger.log(`Attempting to download video for audio extraction using proxy...`);
      const agent = new HttpsProxyAgent(proxyUrl);
      await this.downloadToFile(videoUrl, tempVideoPath, agent);
      downloaded = true;
    } catch (proxyError: any) {
      this.logger.warn(`Proxy download for audio failed: ${proxyError.message}. Retrying direct download...`);
    }

    // 2. Fallback to direct download
    if (!downloaded) {
      try {
        this.logger.log(`Downloading video for audio extraction directly...`);
        await this.downloadToFile(videoUrl, tempVideoPath);
      } catch (directError: any) {
        this.logger.error(`Direct video download for audio failed: ${directError.message}`);
        this.cleanupFile(tempVideoPath);
        throw new BadRequestException(`Could not download video for audio extraction: ${directError.message}`);
      }
    }

    // 3. Extract audio and stream
    try {
      this.logger.log(`Video downloaded successfully. Extracting audio...`);
      const { outputPath } = await this.mediaService.extractAudio(
        tempVideoPath,
        'mp3',
        '192',
      );

      this.logger.log(`Audio extracted to: ${outputPath}. Streaming to client...`);

      const audioFilename = `instagram_${username}_${Date.now()}.mp3`;

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Disposition', `attachment; filename="${audioFilename}"`);

      const audioStream = fs.createReadStream(outputPath);
      audioStream.pipe(res);

      res.on('finish', () => {
        this.cleanupFile(tempVideoPath);
        this.cleanupFile(outputPath);
      });

      audioStream.on('error', (err) => {
        this.logger.error(`Audio read stream error: ${err.message}`);
        this.cleanupFile(tempVideoPath);
        this.cleanupFile(outputPath);
      });
    } catch (error: any) {
      this.logger.error(`Error during audio extraction and stream: ${error.message}`);
      this.cleanupFile(tempVideoPath);
      throw new BadRequestException(`Could not extract audio: ${error.message}`);
    }
  }

  private async downloadToFile(url: string, destPath: string, agent?: HttpsProxyAgent<string>) {
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      httpsAgent: agent,
      httpAgent: agent,
      headers: this.getDownloadHeaders(),
    });

    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);

    return new Promise<void>((resolve, reject) => {
      writer.on('finish', () => resolve());
      writer.on('error', (err) => reject(err));
    });
  }

  private getDownloadHeaders() {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.instagram.com/',
      'Origin': 'https://www.instagram.com',
    };
  }

  private cleanupFile(filePath: string) {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        this.logger.log(`Cleaned up temp file: ${filePath}`);
      } catch (err: any) {
        this.logger.error(`Failed to delete temp file ${filePath}: ${err.message}`);
      }
    }
  }
}

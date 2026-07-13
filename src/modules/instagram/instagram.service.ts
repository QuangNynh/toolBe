import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Response } from 'express';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as ExcelJS from 'exceljs';
import { ZipArchive } from 'archiver';
import pLimit from 'p-limit';
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
   * Helper to extract username from an Instagram profile URL or use it directly if it's already a username
   */
  private getUsername(input: string): string {
    const trimmed = input.trim();

    // If it looks like a URL (contains slashes or instagram.com)
    if (trimmed.includes('/') || trimmed.includes('instagram.com')) {
      const match = trimmed.match(/(?:instagram\.com\/)([A-Za-z0-9_.-]+)/);
      if (!match) {
        throw new BadRequestException('Invalid Instagram profile URL.');
      }
      return match[1];
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
    const agent = this.proxyService.getProxyAgent();

    // 1. Try with proxy first
    if (agent) {
      try {
        this.logger.log(`Attempting to fetch Instagram metadata using proxy`);
        return await this.fetchInstagramDataCustom(url, agent);
      } catch (proxyError: any) {
        this.logger.warn(
          `Proxy request failed (${proxyError.message}). Retrying with direct connection...`
        );
      }
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
   * Fetches Instagram profile information (to retrieve followers count, total posts count, etc.)
   */
  private async getWebProfileInfo(username: string): Promise<any> {
    const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
    const agent = this.proxyService.getProxyAgent();

    let responseData: any;
    let fetched = false;

    // 1. Try with proxy
    if (agent) {
      try {
        this.logger.log(`Fetching web profile info using proxy`);
        const response = await axios.request({
          method: 'GET',
          url,
          httpsAgent: agent,
          httpAgent: agent,
          headers: this.getUserFeedHeaders(username),
        });
        responseData = response.data;
        fetched = true;
      } catch (proxyError: any) {
        this.logger.warn(`Proxy request for web profile info failed: ${proxyError.message}. Retrying direct...`);
      }
    }

    // 2. Fallback to direct connection
    if (!fetched) {
      try {
        this.logger.log(`Fetching web profile info directly (no proxy)`);
        const response = await axios.request({
          method: 'GET',
          url,
          headers: this.getUserFeedHeaders(username),
        });
        responseData = response.data;
      } catch (directError: any) {
        this.logger.error(`Direct request for web profile info failed: ${directError.message}`);
        throw new BadRequestException(`Failed to retrieve web profile info: ${directError.message}`);
      }
    }

    if (!responseData || !responseData.data || !responseData.data.user) {
      throw new BadRequestException('Failed to extract user profile data.');
    }

    return responseData.data.user;
  }

  /**
   * Fetch all posts/videos of a single Instagram channel/user with page and pageSize pagination
   * Option B: Always fetch up to MAX_PAGES = Math.ceil(overallTotalCount / 12) to crawl all items.
   * Leverages file caching inside project directory 'data/instagram/' to prevent redundant Instagram hits.
   */
  async getChannelVideos(
    usernameOrUrl: string,
    typeFilter?: string,
    page: number = 1,
    pageSize: number = 10,
  ) {
    const username = this.getUsername(usernameOrUrl);
    this.logger.log(
      `Fetching channel videos (Option B with file cache) for username: ${username}, page: ${page}, pageSize: ${pageSize}, filter: ${typeFilter}`,
    );

    if (page < 1) page = 1;
    if (pageSize < 1) pageSize = 10;
    if (pageSize > 200) pageSize = 200; // Limit page size to avoid massive requests

    const targetCount = page * pageSize;

    // Establish cache file location
    const cacheDir = path.join(process.cwd(), 'data', 'instagram');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFilePath = path.join(cacheDir, `${username}.json`);

    let cachedData: {
      user: any;
      items: any[];
      overallTotalCount: number;
    } | null = null;

    // Try reading cache file if it exists
    if (fs.existsSync(cacheFilePath)) {
      try {
        this.logger.log(`Loading cached data from project file: ${cacheFilePath}`);
        const fileContent = fs.readFileSync(cacheFilePath, 'utf-8');
        cachedData = JSON.parse(fileContent);
      } catch (err: any) {
        this.logger.error(`Failed to read or parse cache file: ${err.message}. Will fetch fresh data.`);
      }
    }

    let overallTotalCount = 0;
    let formattedItems: any[] = [];
    let userProfile: any = null;

    if (cachedData) {
      userProfile = cachedData.user;
      formattedItems = cachedData.items;
      overallTotalCount = cachedData.overallTotalCount;
    } else {
      // Safety check to prevent hitting rate limits ONLY when cache doesn't exist
      if (targetCount > 500) {
        throw new BadRequestException(
          `Request offset (${targetCount}) is too high for first-time fetching. ` +
          `Please run the background crawler command "node scripts/scrape-instagram.js ${username}" first to download the feed locally.`
        );
      }

      // 1. Fetch web profile info to get the total count of posts and user details
      const profileInfo = await this.getWebProfileInfo(username);
      overallTotalCount = profileInfo.edge_owner_to_timeline_media?.count || 0;
      userProfile = {
        username: profileInfo.username || username,
        fullname: profileInfo.full_name || '',
        profilePicUrl: profileInfo.profile_pic_url || '',
        id: profileInfo.pk || '',
        followersCount: profileInfo.edge_followed_by?.count || 0,
        followingCount: profileInfo.edge_follow?.count || 0,
      };

      // 2. Fetch feed items sequentially from Instagram to collect all available posts up to MAX_PAGES
      const baseFeedUrl = `https://www.instagram.com/api/v1/feed/user/${username}/username/`;
      const agent = this.proxyService.getProxyAgent();

      let allItems: any[] = [];
      let currentMaxId: string | null = null;
      let hasMore = true;
      let pagesFetched = 0;

      // Dynamically calculate MAX_PAGES to crawl the entire channel
      const MAX_PAGES = overallTotalCount > 0 ? Math.ceil(overallTotalCount / 12) : 100;

      while (hasMore && pagesFetched < MAX_PAGES) {
        let url = baseFeedUrl;
        if (currentMaxId) {
          url += `?max_id=${currentMaxId}`;
        }

        this.logger.log(
          `Fetching page ${pagesFetched + 1}/${MAX_PAGES} for ${username}...`,
        );
        let responseData: any;
        let fetched = false;

        // Try with proxy
        if (agent) {
          try {
            const response = await axios.request({
              method: 'GET',
              url,
              httpsAgent: agent,
              httpAgent: agent,
              headers: this.getUserFeedHeaders(username),
            });
            responseData = response.data;
            fetched = true;
          } catch (proxyError: any) {
            this.logger.warn(
              `Proxy request page ${pagesFetched + 1} failed: ${proxyError.message}. Retrying direct...`,
            );
          }
        }

        // Fallback to direct connection
        if (!fetched) {
          try {
            const response = await axios.request({
              method: 'GET',
              url,
              headers: this.getUserFeedHeaders(username),
            });
            responseData = response.data;
          } catch (directError: any) {
            this.logger.error(`Direct user feed request failed: ${directError.message}`);
            throw new BadRequestException(
              `Failed to retrieve user feed on page ${pagesFetched + 1}: ${directError.message}`,
            );
          }
        }

        if (!responseData || !responseData.items) {
          break;
        }

        allItems = allItems.concat(responseData.items);
        hasMore = responseData.more_available === true;
        currentMaxId = responseData.next_max_id;
        pagesFetched++;

        if (!currentMaxId) {
          hasMore = false;
        }

        // Small sleep to prevent quick rate limit bans
        if (hasMore) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }

      // Format items
      formattedItems = allItems.map((item: any) => {
        let type = 'image';
        if (item.media_type === 2) {
          type = 'video';
        } else if (item.media_type === 8) {
          type = 'carousel';
        }

        return {
          id: item.id,
          shortcode: item.code,
          type,
          title: item.caption?.text || '',
          videoUrl: item.video_versions?.[0]?.url || null,
          thumbnailUrl: item.image_versions2?.candidates?.[0]?.url || null,
          likes: item.like_count || 0,
          comments: item.comment_count || 0,
          views: item.play_count || item.view_count || 0,
          takenAt: item.taken_at,
        };
      });

      // Save to cache file inside the project directory
      try {
        const dataToCache = {
          user: userProfile,
          items: formattedItems,
          overallTotalCount,
        };
        this.logger.log(`Caching feed data to file: ${cacheFilePath}`);
        fs.writeFileSync(cacheFilePath, JSON.stringify(dataToCache, null, 2), 'utf-8');
      } catch (err: any) {
        this.logger.error(`Failed to write cache file: ${err.message}`);
      }
    }

    // Apply type filter if provided
    let filteredItems = [...formattedItems];
    if (typeFilter) {
      const allowedFilters = ['video', 'image', 'carousel'];
      const targetTypes = typeFilter
        .split(',')
        .map((t) => t.toLowerCase().trim())
        .filter((t) => allowedFilters.includes(t));

      if (targetTypes.length > 0) {
        filteredItems = filteredItems.filter((item: any) => targetTypes.includes(item.type));
      }
    }

    // Sort items by takenAt in ascending order (oldest to newest)
    filteredItems.sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0));

    // 5. Slice exactly to the requested page and pageSize
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const slicedItems = filteredItems.slice(startIndex, endIndex);

    return {
      success: true,
      user: userProfile,
      items: slicedItems,
      pagination: {
        page,
        pageSize,
        totalCount: filteredItems.length,
        hasMore: filteredItems.length > endIndex,
      },
    };
  }

  /**
   * Exports all channel posts matching the filter to an Excel sheet.
   * Leverages cached project data file.
   */
  async exportChannelVideosToExcel(
    usernameOrUrl: string,
    res: Response,
    typeFilter?: string,
  ) {
    const username = this.getUsername(usernameOrUrl);
    this.logger.log(
      `Exporting channel data to Excel for: ${username}, filter: ${typeFilter}`,
    );

    const cacheDir = path.join(process.cwd(), 'data', 'instagram');
    const cacheFilePath = path.join(cacheDir, `${username}.json`);

    if (!fs.existsSync(cacheFilePath)) {
      throw new BadRequestException(
        `No cached data found for channel ${username}. ` +
        `Please fetch the channel feed or run the scraper first.`
      );
    }

    let items: any[] = [];
    try {
      const fileContent = fs.readFileSync(cacheFilePath, 'utf-8');
      const cacheData = JSON.parse(fileContent);
      items = cacheData.items || [];
    } catch (err: any) {
      throw new BadRequestException(`Failed to read cache file: ${err.message}`);
    }

    // Filter by type if provided
    if (typeFilter) {
      const allowedFilters = ['video', 'image', 'carousel'];
      const targetTypes = typeFilter
        .split(',')
        .map((t) => t.toLowerCase().trim())
        .filter((t) => allowedFilters.includes(t));

      if (targetTypes.length > 0) {
        items = items.filter((item: any) => targetTypes.includes(item.type));
      }
    }

    // Sort items by takenAt in ascending order (oldest to newest)
    items.sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0));

    // Create workbook and worksheet using exceljs
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Instagram Posts');

    // Define columns
    worksheet.columns = [
      { header: 'STT', key: 'stt', width: 8 },
      { header: 'Link', key: 'link', width: 45 },
      { header: 'Like', key: 'likes', width: 12 },
      { header: 'Lượt xem', key: 'views', width: 15 },
      { header: 'Ngày tạo', key: 'takenAt', width: 18 },
    ];

    // Format header styling (Bold, centered, clean layout)
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    // Add rows
    items.forEach((item, index) => {
      let dateStr = '';
      if (item.takenAt) {
        const date = new Date(item.takenAt * 1000);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        dateStr = `${day}/${month}/${year}`;
      }

      const link = `https://www.instagram.com/p/${item.shortcode}/`;

      worksheet.addRow({
        stt: index + 1,
        link: link,
        likes: item.likes || 0,
        views: item.views || 0,
        takenAt: dateStr,
      });
    });

    // Formatting column alignments
    worksheet.getColumn('stt').alignment = { horizontal: 'center' };
    worksheet.getColumn('likes').alignment = { horizontal: 'right' };
    worksheet.getColumn('views').alignment = { horizontal: 'right' };
    worksheet.getColumn('takenAt').alignment = { horizontal: 'center' };

    // Setup browser download headers
    const filename = `instagram_export_${username}_${Date.now()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );

    // Write file stream directly to client response
    await workbook.xlsx.write(res);
    res.end();
  }

  /**
   * Downloads all matching channel post images, names them by STT (e.g. 1.jpg, 2.jpg)
   * and sends them inside a compressed ZIP archive.
   */
  async exportChannelImagesToZip(
    usernameOrUrl: string,
    res: Response,
    typeFilter?: string,
  ) {
    const username = this.getUsername(usernameOrUrl);
    this.logger.log(
      `Exporting channel images to ZIP for: ${username}, filter: ${typeFilter}`,
    );

    const cacheDir = path.join(process.cwd(), 'data', 'instagram');
    const cacheFilePath = path.join(cacheDir, `${username}.json`);

    if (!fs.existsSync(cacheFilePath)) {
      throw new BadRequestException(
        `No cached data found for channel ${username}. ` +
        `Please fetch the channel feed or run the scraper first.`
      );
    }

    let items: any[] = [];
    try {
      const fileContent = fs.readFileSync(cacheFilePath, 'utf-8');
      const cacheData = JSON.parse(fileContent);
      items = cacheData.items || [];
    } catch (err: any) {
      throw new BadRequestException(`Failed to read cache file: ${err.message}`);
    }

    // Filter by type if provided
    if (typeFilter) {
      const allowedFilters = ['video', 'image', 'carousel'];
      const targetTypes = typeFilter
        .split(',')
        .map((t) => t.toLowerCase().trim())
        .filter((t) => allowedFilters.includes(t));

      if (targetTypes.length > 0) {
        items = items.filter((item: any) => targetTypes.includes(item.type));
      }
    }

    // Sort items by takenAt in ascending order (oldest to newest)
    items.sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0));

    if (items.length === 0) {
      throw new BadRequestException('No items found matching the filter.');
    }

    // Setup headers for zip file download
    const filename = `instagram_images_${username}_${Date.now()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Create zip archive using ZipArchive class from archiver v8.0.0
    const archive = new ZipArchive({ zlib: { level: 9 } });

    // Handle archive errors
    archive.on('error', (err) => {
      this.logger.error(`Archiver error: ${err.message}`);
    });

    // Pipe archive output to Express Response
    archive.pipe(res);

    // Download images concurrently with a limit of 10
    const limit = pLimit(10);

    const downloadPromises = items.map((item, index) => {
      return limit(async () => {
        const stt = index + 1;
        const url = item.thumbnailUrl;
        if (!url) return;

        try {
          // Detect file extension from URL
          let ext = '.jpg';
          if (url.includes('.webp')) ext = '.webp';
          else if (url.includes('.png')) ext = '.png';

          const response = await axios({
            method: 'GET',
            url,
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
          });

          const buffer = Buffer.from(response.data);
          archive.append(buffer, { name: `${stt}${ext}` });
        } catch (err: any) {
          this.logger.warn(
            `Failed to download image ${stt} for channel ${username} from ${url}: ${err.message}`
          );
        }
      });
    });

    try {
      await Promise.all(downloadPromises);
      await archive.finalize();
    } catch (err: any) {
      this.logger.error(`Failed to finalize zip archive: ${err.message}`);
      if (!res.headersSent) {
        throw new BadRequestException(`Failed to generate ZIP archive: ${err.message}`);
      }
    }
  }

  /**
   * Deletes all cached JSON files in the 'data/instagram/' directory.
   */
  async clearAllChannelCache() {
    const cacheDir = path.join(process.cwd(), 'data', 'instagram');

    if (!fs.existsSync(cacheDir)) {
      return {
        success: true,
        message: 'No cache directory found. Nothing to clear.',
        deletedFilesCount: 0,
      };
    }

    try {
      const files = fs.readdirSync(cacheDir);
      let deletedCount = 0;

      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(cacheDir, file);
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }

      this.logger.log(`Cleared all Instagram cache. Deleted ${deletedCount} files.`);
      return {
        success: true,
        message: `Successfully cleared all Instagram cache files.`,
        deletedFilesCount: deletedCount,
      };
    } catch (err: any) {
      throw new BadRequestException(`Failed to clear cache directory: ${err.message}`);
    }
  }

  private getUserFeedHeaders(username: string) {
    return {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-IG-App-ID': '936619743392459',
      'Referer': `https://www.instagram.com/${username}/`,
      'Origin': 'https://www.instagram.com',
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
    const agent = this.proxyService.getProxyAgent();
    if (agent) {
      try {
        this.logger.log(`Attempting to stream video using proxy...`);
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
    const agent = this.proxyService.getProxyAgent();
    if (agent) {
      try {
        this.logger.log(`Attempting to download video for audio extraction using proxy...`);
        await this.downloadToFile(videoUrl, tempVideoPath, agent);
        downloaded = true;
      } catch (proxyError: any) {
        this.logger.warn(`Proxy download for audio failed: ${proxyError.message}. Retrying direct download...`);
      }
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

  private async downloadToFile(url: string, destPath: string, agent?: any) {
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

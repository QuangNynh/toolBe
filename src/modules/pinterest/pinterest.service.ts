/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { CronJob } from 'cron';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as ExcelJS from 'exceljs';
import { ZipArchive } from 'archiver';
import axios, { AxiosError } from 'axios';
import { ProxyService } from '../proxy/proxy.service';
import { SchedulePinDto } from './dto/schedule-pin.dto';

// Set FFmpeg binary path from the bundled installer
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const PINTEREST_API_BASE = 'https://www.pinterest.com/resource';

/** Pinterest v5 REST API base URL for authenticated operations */
const PINTEREST_V5_API = 'https://api.pinterest.com/v5';
const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Referer: 'https://www.pinterest.com/',
};

export interface PinterestAccount {
  username: string;
  fullName?: string;
  avatarUrl?: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // timestamp in milliseconds when token expires
  connectedAt: number; // timestamp when account was connected
}

@Injectable()
export class PinterestService {
  private readonly logger = new Logger(PinterestService.name);
  private readonly accountsFilePath = path.join(process.cwd(), 'data', 'pinterest', 'accounts.json');

  constructor(
    private readonly proxyService: ProxyService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly configService: ConfigService,
  ) {
    // Đảm bảo thư mục lưu trữ tài khoản tồn tại
    const dir = path.dirname(this.accountsFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.accountsFilePath)) {
      fs.writeFileSync(this.accountsFilePath, JSON.stringify([]), 'utf-8');
    }
  }

  // ──────────────────────────────────────────────────────────
  // Pinterest Internal API helpers
  // ──────────────────────────────────────────────────────────

  private async callPinterestApi(
    resource: string,
    options: Record<string, any>,
    pwsHandler = 'www/[username].js',
  ): Promise<any> {
    const data = JSON.stringify({ options });
    const url = `${PINTEREST_API_BASE}/${resource}/get/?data=${encodeURIComponent(data)}`;

    const agent = this.proxyService.getProxyAgent();
    const response = await axios.get(url, {
      headers: {
        ...DEFAULT_HEADERS,
        'X-Pinterest-PWS-Handler': pwsHandler,
      },
      httpsAgent: agent,
      httpAgent: agent,
    });

    const json = response.data;
    const resourceResponse = json?.resource_response;

    if (resourceResponse?.error) {
      throw new BadRequestException(
        `Pinterest API error: ${resourceResponse.error.message || 'Unknown error'}`,
      );
    }

    return resourceResponse;
  }

  // ──────────────────────────────────────────────────────────
  // URL parsing helpers
  // ──────────────────────────────────────────────────────────

  /**
   * Parse Pinterest URL thành loại + thông tin tương ứng
   * Trả về: { type: 'profile'|'board'|'created'|'saved'|'pin', username, slug?, pinId? }
   */
  private parseUrl(url: string): {
    type: 'profile' | 'board' | 'created' | 'saved' | 'pin';
    username: string;
    slug?: string;
    pinId?: string;
  } {
    const trimmed = url.trim().replace(/\/+$/, '');

    // Pin URL: /pin/123456
    const pinMatch = trimmed.match(/pinterest\.com\/pin\/([0-9]+)/);
    if (pinMatch) {
      return { type: 'pin', username: '', pinId: pinMatch[1] };
    }

    // Two-segment path: /username/something
    const twoSeg = trimmed.match(
      /pinterest\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/,
    );
    if (twoSeg) {
      const username = twoSeg[1];
      const slug = twoSeg[2];

      if (['pin', 'search', 'resource', 'api'].includes(username)) {
        throw new BadRequestException('Invalid Pinterest URL.');
      }

      if (slug === '_created') return { type: 'created', username };
      if (slug === '_saved') return { type: 'saved', username };
      return { type: 'board', username, slug };
    }

    // One-segment path: /username
    const oneSeg = trimmed.match(
      /pinterest\.com\/([A-Za-z0-9_.-]+)\/?$/,
    );
    if (oneSeg) {
      const username = oneSeg[1];
      if (['pin', 'search', 'resource', 'api'].includes(username)) {
        throw new BadRequestException('Invalid Pinterest URL.');
      }
      return { type: 'profile', username };
    }

    throw new BadRequestException(
      'Invalid Pinterest URL. Supported formats: profile, board, _created, _saved, pin.',
    );
  }

  /**
   * Tạo cache key dựa trên loại URL
   */
  private getCacheKey(parsed: ReturnType<typeof this.parseUrl>): string {
    switch (parsed.type) {
      case 'profile':
      case 'saved':
        return `${parsed.username}__saved`;
      case 'created':
        return `${parsed.username}__created`;
      case 'board':
        return `${parsed.username}__${parsed.slug}`;
      default:
        return parsed.username;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Pin data mapping
  // ──────────────────────────────────────────────────────────

  private mapPinData(pin: any) {
    const images = pin.images || {};
    let origImage =
      images.orig?.url ||
      images['736x']?.url ||
      images['474x']?.url ||
      null;

    // Fallback for story pin images if origImage is missing
    if (!origImage && pin.story_pin_data?.pages) {
      for (const page of pin.story_pin_data.pages) {
        const pageImages = page.image?.images || {};
        const pageImage = pageImages.originals?.url || pageImages['750x']?.url || pageImages['736x']?.url;
        if (pageImage) {
          origImage = pageImage;
          break;
        }
      }
    }

    let videoUrl: string | null = null;
    if (pin.videos?.video_list) {
      const videoList = pin.videos.video_list;
      const preferred = ['V_720P', 'V_480P30', 'V_480P', 'V_360P'];
      for (const key of preferred) {
        if (videoList[key]?.url) {
          videoUrl = videoList[key].url;
          break;
        }
      }
      if (!videoUrl) {
        const entries = Object.values(videoList) as any[];
        const sorted = entries
          .filter((v) => v.url)
          .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
        videoUrl = sorted[0]?.url ?? null;
      }
    }

    // Fallback for story/idea pins containing video blocks
    if (!videoUrl && pin.story_pin_data?.pages) {
      for (const page of pin.story_pin_data.pages) {
        // 1. Check blocks inside page
        if (page.blocks) {
          for (const block of page.blocks) {
            if (block.video?.video_list) {
              const videoList = block.video.video_list;
              const preferred = ['V_EXP7', 'V_EXP6', 'V_EXP5', 'V_EXP4', 'V_EXP3', 'V_HLSV3_MOBILE'];
              for (const key of preferred) {
                if (videoList[key]?.url) {
                  videoUrl = videoList[key].url;
                  break;
                }
              }
              if (!videoUrl) {
                const entries = Object.values(videoList) as any[];
                const sorted = entries
                  .filter((v) => v.url)
                  .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
                videoUrl = sorted[0]?.url ?? null;
              }
            }
            if (videoUrl) break;
          }
        }
        // 2. Check page-level video
        if (!videoUrl && page.video?.video_list) {
          const videoList = page.video.video_list;
          const preferred = ['V_EXP7', 'V_EXP6', 'V_EXP5', 'V_EXP4', 'V_EXP3', 'V_HLSV3_MOBILE'];
          for (const key of preferred) {
            if (videoList[key]?.url) {
              videoUrl = videoList[key].url;
              break;
            }
          }
          if (!videoUrl) {
            const entries = Object.values(videoList) as any[];
            const sorted = entries
              .filter((v) => v.url)
              .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
            videoUrl = sorted[0]?.url ?? null;
          }
        }
        if (videoUrl) break;
      }
    }

    const isVideo = !!(pin.is_video || pin.videos || videoUrl);
    const saves =
      pin.aggregated_pin_data?.aggregated_stats?.saves ??
      pin.repin_count ??
      0;

    let likeCount = 0;
    if (pin.reaction_counts) {
      likeCount = (Object.values(pin.reaction_counts) as any[]).reduce(
        (sum: number, val: any): number => sum + (Number(val) || 0),
        0,
      );
    }

    // Parse created_at thành timestamp
    let timestamp: number | null = null;
    if (pin.created_at) {
      const d = new Date(pin.created_at);
      if (!isNaN(d.getTime())) {
        timestamp = Math.floor(d.getTime() / 1000);
      }
    }

    return {
      id: pin.id ?? null,
      title: pin.title || pin.grid_title || null,
      description: pin.description || pin.raw_description || pin.seo_description || null,
      type: isVideo ? 'video' : 'image',
      is_video: isVideo,
      pin_url: `https://www.pinterest.com/pin/${pin.id}/`,
      link: pin.link || pin.link_url || pin.destination_url || pin.rich_metadata?.url || null,
      domain: pin.domain || null,
      created_at: pin.created_at || null,
      takenAt: timestamp,
      comment_count: pin.comment_count ?? 0,
      like_count: likeCount,
      repin_count: pin.repin_count ?? 0,
      save_count: saves,
      image_url: origImage,
      video_url: videoUrl,
      pinner: pin.pinner
        ? {
            username: pin.pinner.username ?? null,
            full_name: pin.pinner.full_name ?? null,
            id: pin.pinner.id ?? null,
          }
        : null,
      board: pin.board
        ? {
            name: pin.board.name ?? null,
            url: pin.board.url ?? null,
          }
        : null,
    };
  }

  // ──────────────────────────────────────────────────────────
  // Core: Fetch + Cache (giống Instagram pattern)
  // ──────────────────────────────────────────────────────────

  /**
   * Fetch toàn bộ pins từ Pinterest channel (user/board/_created/_saved)
   * với file caching + pagination server-side giống Instagram module
   */
  async getChannelPins(
    urlOrUsername: string,
    typeFilter?: string,
    page: number = 1,
    pageSize: number = 10,
  ) {
    const parsed = this.parseUrl(urlOrUsername);

    if (parsed.type === 'pin') {
      throw new BadRequestException(
        'This endpoint is for user/board/channel. Use /pinterest/video or /pinterest/image for single pin.',
      );
    }

    this.logger.log(
      `Fetching Pinterest channel [${parsed.type}]: ${parsed.username}/${parsed.slug || ''}, page=${page}, pageSize=${pageSize}, filter=${typeFilter}`,
    );

    if (page < 1) page = 1;
    if (pageSize < 1) pageSize = 10;
    if (pageSize > 200) pageSize = 200;

    // ── Cache setup ──
    const cacheDir = path.join(process.cwd(), 'data', 'pinterest');
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const cacheKey = this.getCacheKey(parsed);
    const cacheFilePath = path.join(cacheDir, `${cacheKey}.json`);

    let cachedData: {
      user: any;
      boardInfo?: any;
      items: any[];
      overallTotalCount: number;
    } | null = null;

    // Đọc cache nếu tồn tại
    const cacheExists = await fs.promises.access(cacheFilePath).then(() => true).catch(() => false);
    if (cacheExists) {
      try {
        this.logger.log(`Loading cached data from: ${cacheFilePath}`);
        const fileContent = await fs.promises.readFile(cacheFilePath, 'utf-8');
        cachedData = JSON.parse(fileContent);
      } catch (err: any) {
        this.logger.error(
          `Failed to read cache file: ${err.message}. Will fetch fresh data.`,
        );
      }
    }

    let overallTotalCount = 0;
    let formattedItems: any[] = [];
    let userProfile: any = null;
    let boardInfo: any = null;

    if (cachedData) {
      // ── Sử dụng cache ──
      userProfile = cachedData.user;
      boardInfo = cachedData.boardInfo || null;
      formattedItems = cachedData.items;
      overallTotalCount = cachedData.overallTotalCount;
    } else {
      // ── Fetch mới từ Pinterest API ──
      // Lấy thông tin user
      const userResponse = await this.callPinterestApi('UserResource', {
        username: parsed.username,
      });
      const userData = userResponse?.data;
      if (!userData) {
        throw new BadRequestException(
          `User "${parsed.username}" not found`,
        );
      }

      userProfile = {
        username: userData.username || parsed.username,
        full_name: userData.full_name || '',
        id: userData.id || '',
        follower_count: userData.follower_count || 0,
        pin_count: userData.pin_count || 0,
      };

      // Xác định resource + options dựa trên type
      let resourceName: string;
      let pwsHandler: string;
      let baseOptions: any;
      let boardId: string | null = null;

      switch (parsed.type) {
        case 'board': {
          // Lấy board_id trước
          const boardResponse = await this.callPinterestApi(
            'BoardResource',
            {
              slug: parsed.slug,
              username: parsed.username,
              field_set_key: 'detailed',
            },
            'www/[username]/[slug].js',
          );
          const boardData = boardResponse?.data;
          if (!boardData) {
            throw new BadRequestException(
              `Board "${parsed.slug}" not found for user "${parsed.username}"`,
            );
          }
          boardId = boardData.id;
          boardInfo = {
            name: boardData.name,
            id: boardId,
            pin_count: boardData.pin_count ?? 0,
            url: boardData.url,
          };
          overallTotalCount = boardData.pin_count ?? 0;
          resourceName = 'BoardFeedResource';
          pwsHandler = 'www/[username]/[slug].js';
          baseOptions = { board_id: boardId };
          break;
        }

        case 'created': {
          // _created chỉ trả về pins user TỰ TẠO (không bao gồm repins)
          // pin_count bao gồm cả repins, nên KHÔNG dùng làm overallTotalCount
          // Để overallTotalCount = 0 → MAX_PAGES dùng fallback lớn, crawl tới khi hết bookmark
          overallTotalCount = 0;
          resourceName = 'UserActivityPinsResource';
          pwsHandler = 'www/[username]/_created.js';
          baseOptions = {
            username: parsed.username,
            exclude_add_pin_rep: true,
          };
          break;
        }

        case 'profile':
        case 'saved':
        default: {
          overallTotalCount = userData.pin_count ?? 0;
          resourceName = 'UserPinsResource';
          pwsHandler = 'www/[username]/_saved.js';
          baseOptions = { username: parsed.username };
          break;
        }
      }

      // Phân trang lấy toàn bộ pins — dựa vào BOOKMARK để biết khi nào thật sự hết
      const allPins: any[] = [];
      let bookmark: string | null = null;
      let pagesFetched = 0;
      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 5;
      // Safety cap: tối đa 2000 pages (100k pins) để tránh loop vô hạn
      const ABSOLUTE_MAX_PAGES = 2000;

      while (pagesFetched < ABSOLUTE_MAX_PAGES) {
        const options: any = {
          ...baseOptions,
          page_size: 250,
        };
        if (bookmark) {
          options.bookmarks = [bookmark];
        }

        this.logger.log(
          `Fetching page ${pagesFetched + 1} for ${parsed.username} [${parsed.type}] (${allPins.length} pins so far)...`,
        );

        let feedResponse: any;
        try {
          feedResponse = await this.callPinterestApi(
            resourceName,
            options,
            pwsHandler,
          );
        } catch (apiError: any) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            this.logger.warn(
              `Pinterest API error ${MAX_CONSECUTIVE_ERRORS} lần liên tiếp. ` +
                `Dừng lại với ${allPins.length} pins. Error: ${apiError.message}`,
            );
            break;
          }
          this.logger.warn(
            `Pinterest API error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${apiError.message}. Chờ 3s rồi thử lại...`,
          );
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }

        const newBookmark = feedResponse?.bookmark ?? null;
        const pins = feedResponse?.data ?? [];

        if (pins.length > 0) {
          consecutiveErrors = 0;
          allPins.push(...pins);
          pagesFetched++;
        }

        // Kiểm tra điều kiện dừng: bookmark hết = Pinterest đã trả hết data
        if (!newBookmark || newBookmark === '-end-') {
          this.logger.log(
            `Pinterest trả hết data (bookmark=${newBookmark || 'null'}). Tổng: ${allPins.length} pins trong ${pagesFetched} pages.`,
          );
          break;
        }

        // Nếu có bookmark mới nhưng data rỗng → Pinterest tạm lag, tiếp tục với bookmark mới
        if (pins.length === 0) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            this.logger.warn(
              `${MAX_CONSECUTIVE_ERRORS} lần liên tiếp không có data mới (nhưng vẫn có bookmark). ` +
                `Dừng lại với ${allPins.length} pins.`,
            );
            break;
          }
          this.logger.warn(
            `Page rỗng nhưng bookmark vẫn có (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}). Chờ 2s rồi tiếp tục...`,
          );
          bookmark = newBookmark;
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }

        bookmark = newBookmark;

        // Delay nhỏ để tránh bị rate limit
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      this.logger.log(
        `Hoàn tất: ${allPins.length} pins trong ${pagesFetched} pages cho ${parsed.username} [${parsed.type}].`,
      );

      // Format items
      formattedItems = allPins.map((pin) => this.mapPinData(pin));

      // Lưu cache
      try {
        const dataToCache = {
          user: userProfile,
          boardInfo,
          items: formattedItems,
          overallTotalCount,
        };
        this.logger.log(`Caching Pinterest data to: ${cacheFilePath}`);
        await fs.promises.writeFile(
          cacheFilePath,
          JSON.stringify(dataToCache, null, 2),
          'utf-8',
        );
      } catch (err: any) {
        this.logger.error(`Failed to write cache file: ${err.message}`);
      }
    }

    // ── Filter theo type ──
    let filteredItems = [...formattedItems];
    if (typeFilter) {
      const allowedFilters = ['video', 'image'];
      const targetTypes = typeFilter
        .split(',')
        .map((t) => t.toLowerCase().trim())
        .filter((t) => allowedFilters.includes(t));

      if (targetTypes.length > 0) {
        filteredItems = filteredItems.filter((item: any) =>
          targetTypes.includes(item.type),
        );
      }
    }

    // Sort theo takenAt ascending (cũ nhất → mới nhất) giống Instagram
    filteredItems.sort(
      (a, b) => (a.takenAt || 0) - (b.takenAt || 0),
    );

    // ── Slice theo page + pageSize ──
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const slicedItems = filteredItems.slice(startIndex, endIndex);

    return {
      success: true,
      user: userProfile,
      board: boardInfo,
      items: slicedItems,
      pagination: {
        page,
        pageSize,
        totalCount: filteredItems.length,
        hasMore: filteredItems.length > endIndex,
      },
    };
  }

  // ──────────────────────────────────────────────────────────
  // Export Excel (giống Instagram pattern)
  // ──────────────────────────────────────────────────────────

  async exportChannelToExcel(
    urlOrUsername: string,
    res: Response,
    typeFilter?: string,
  ) {
    const parsed = this.parseUrl(urlOrUsername);
    const cacheKey = this.getCacheKey(parsed);
    this.logger.log(
      `Exporting Pinterest data to Excel for: ${cacheKey}, filter: ${typeFilter}`,
    );

    const cacheDir = path.join(process.cwd(), 'data', 'pinterest');
    const cacheFilePath = path.join(cacheDir, `${cacheKey}.json`);

    if (!fs.existsSync(cacheFilePath)) {
      throw new BadRequestException(
        `No cached data found for "${cacheKey}". ` +
          `Please fetch the channel/board first using /pinterest/channel.`,
      );
    }

    let items: any[] = [];
    try {
      const fileContent = fs.readFileSync(cacheFilePath, 'utf-8');
      const cacheData = JSON.parse(fileContent);
      items = cacheData.items || [];
    } catch (err: any) {
      throw new BadRequestException(
        `Failed to read cache file: ${err.message}`,
      );
    }

    // Filter by type
    if (typeFilter) {
      const allowedFilters = ['video', 'image'];
      const targetTypes = typeFilter
        .split(',')
        .map((t) => t.toLowerCase().trim())
        .filter((t) => allowedFilters.includes(t));
      if (targetTypes.length > 0) {
        items = items.filter((item: any) =>
          targetTypes.includes(item.type),
        );
      }
    }

    // Sort ascending
    items.sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0));

    // Create workbook
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Pinterest Pins');

    worksheet.columns = [
      { header: 'STT', key: 'stt', width: 8 },
      { header: 'Link Pin', key: 'pin_url', width: 45 },
      { header: 'Link đính kèm', key: 'link', width: 50 },
      { header: 'Type', key: 'type', width: 10 },
      { header: 'Tiêu đề', key: 'title', width: 30 },
      { header: 'Mô tả', key: 'description', width: 40 },
      { header: 'Likes', key: 'likes', width: 12 },
      { header: 'Saves', key: 'saves', width: 12 },
      { header: 'Repins', key: 'repins', width: 12 },
      { header: 'Comments', key: 'comments', width: 12 },
      { header: 'Ngày tạo', key: 'created_at', width: 18 },
    ];

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).alignment = {
      vertical: 'middle',
      horizontal: 'center',
    };

    items.forEach((item, index) => {
      let dateStr = '';
      if (item.takenAt) {
        const date = new Date(item.takenAt * 1000);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        dateStr = `${day}/${month}/${year}`;
      }

      worksheet.addRow({
        stt: index + 1,
        pin_url: item.pin_url || '',
        link: item.link || '',
        type: item.type || '',
        title: item.title || '',
        description: item.description || '',
        likes: item.like_count || 0,
        saves: item.save_count || 0,
        repins: item.repin_count || 0,
        comments: item.comment_count || 0,
        created_at: dateStr,
      });
    });

    worksheet.getColumn('stt').alignment = { horizontal: 'center' };
    worksheet.getColumn('likes').alignment = { horizontal: 'right' };
    worksheet.getColumn('saves').alignment = { horizontal: 'right' };
    worksheet.getColumn('repins').alignment = { horizontal: 'right' };
    worksheet.getColumn('comments').alignment = { horizontal: 'right' };
    worksheet.getColumn('created_at').alignment = { horizontal: 'center' };

    const filename = `pinterest_export_${cacheKey}_${Date.now()}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );

    await workbook.xlsx.write(res);
    res.end();
  }

  // ──────────────────────────────────────────────────────────
  // Export Images ZIP (giống Instagram pattern)
  // ──────────────────────────────────────────────────────────

  async exportImagesToZip(
    urlOrUsername: string,
    res: Response,
    typeFilter?: string,
  ) {
    const parsed = this.parseUrl(urlOrUsername);
    const cacheKey = this.getCacheKey(parsed);
    this.logger.log(
      `Exporting Pinterest images to ZIP for: ${cacheKey}, filter: ${typeFilter}`,
    );

    const cacheDir = path.join(process.cwd(), 'data', 'pinterest');
    const cacheFilePath = path.join(cacheDir, `${cacheKey}.json`);

    if (!fs.existsSync(cacheFilePath)) {
      throw new BadRequestException(
        `No cached data found for "${cacheKey}". ` +
          `Please fetch the channel/board first using /pinterest/channel.`,
      );
    }

    let items: any[] = [];
    try {
      const fileContent = fs.readFileSync(cacheFilePath, 'utf-8');
      const cacheData = JSON.parse(fileContent);
      items = cacheData.items || [];
    } catch (err: any) {
      throw new BadRequestException(
        `Failed to read cache file: ${err.message}`,
      );
    }

    // Filter by type
    if (typeFilter) {
      const allowedFilters = ['video', 'image'];
      const targetTypes = typeFilter
        .split(',')
        .map((t) => t.toLowerCase().trim())
        .filter((t) => allowedFilters.includes(t));
      if (targetTypes.length > 0) {
        items = items.filter((item: any) =>
          targetTypes.includes(item.type),
        );
      }
    }

    // Sort ascending
    items.sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0));

    if (items.length === 0) {
      throw new BadRequestException('No items found matching the filter.');
    }

    const filename = `pinterest_images_${cacheKey}_${Date.now()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );

    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on('error', (err) => {
      this.logger.error(`Archiver error: ${err.message}`);
    });
    archive.pipe(res);

    // Download images concurrently (limit 10)
    const downloadPromises = items.map((item, index) => {
      return (async () => {
        const stt = index + 1;
        const imageUrl = item.image_url;
        if (!imageUrl) return;

        try {
          let ext = '.jpg';
          if (imageUrl.includes('.png')) ext = '.png';
          else if (imageUrl.includes('.webp')) ext = '.webp';
          else if (imageUrl.includes('.gif')) ext = '.gif';

          const agent = this.proxyService.getProxyAgent();
          const response = await axios({
            method: 'GET',
            url: imageUrl,
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: {
              'User-Agent': DEFAULT_HEADERS['User-Agent'],
              Referer: 'https://www.pinterest.com/',
            },
            httpsAgent: agent,
            httpAgent: agent,
          });

          const buffer = Buffer.from(response.data);
          archive.append(buffer, { name: `${stt}${ext}` });
        } catch (err: any) {
          this.logger.warn(
            `Failed to download image ${stt}: ${err.message}`,
          );
        }
      })();
    });

    try {
      await Promise.all(downloadPromises);
      await archive.finalize();
    } catch (err: any) {
      this.logger.error(
        `Failed to finalize zip archive: ${err.message}`,
      );
      if (!res.headersSent) {
        throw new BadRequestException(
          `Failed to generate ZIP archive: ${err.message}`,
        );
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // Clear cache (giống Instagram pattern)
  // ──────────────────────────────────────────────────────────

  async clearAllCache() {
    const cacheDir = path.join(process.cwd(), 'data', 'pinterest');

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

      this.logger.log(
        `Cleared all Pinterest cache. Deleted ${deletedCount} files.`,
      );
      return {
        success: true,
        message: 'Successfully cleared all Pinterest cache files.',
        deletedFilesCount: deletedCount,
      };
    } catch (err: any) {
      throw new BadRequestException(
        `Failed to clear cache directory: ${err.message}`,
      );
    }
  }

  // ──────────────────────────────────────────────────────────
  // Download single pin: Video / Image / Audio
  // ──────────────────────────────────────────────────────────

  private async getPinDetail(pinId: string): Promise<any> {
    const response = await this.callPinterestApi(
      'PinResource',
      {
        id: pinId,
        field_set_key: 'unauth_react_main_pin',
      },
      'www/pin/[id].js',
    );
    return response?.data;
  }

  async downloadVideo(url: string, res: Response) {
    let rawFile: string | null = null;
    let finalFile: string | null = null;
    try {
      const parsed = this.parseUrl(url);
      if (parsed.type !== 'pin' || !parsed.pinId) {
        throw new BadRequestException(
          'Please provide a single pin URL: https://www.pinterest.com/pin/123456/',
        );
      }

      this.logger.log(`Fetching Pinterest pin: ${parsed.pinId}`);
      const pinData = await this.getPinDetail(parsed.pinId);
      if (!pinData) {
        throw new BadRequestException('Pin not found');
      }

      const mapped = this.mapPinData(pinData);
      if (!mapped.is_video || !mapped.video_url) {
        throw new BadRequestException(
          'This pin does not contain a video. Use /pinterest/image to download images.',
        );
      }

      const title = mapped.title || mapped.description || 'pinterest_video';
      const sanitizedTitle =
        this.sanitizeFilename(title).substring(0, 50) || 'pinterest_video';
      const filename = `${sanitizedTitle}.mp4`;

      const tempDir = os.tmpdir();
      rawFile = path.join(tempDir, `pinterest-${Date.now()}-raw.mp4`);
      finalFile = path.join(tempDir, `pinterest-${Date.now()}-final.mp4`);

      this.logger.log(`Downloading Pinterest video...`);
      let videoResponse: any;
      let lastErr: any = null;
      let downloadSuccess = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const agent = this.proxyService.getProxyAgent();
          const config: any = {
            responseType: 'arraybuffer',
            headers: {
              'User-Agent': DEFAULT_HEADERS['User-Agent'],
              Referer: 'https://www.pinterest.com/',
            },
            timeout: 30000,
            httpsAgent: agent,
            httpAgent: agent,
          };
          this.logger.log(`Attempt ${attempt}: Downloading video via Proxy bridge`);

          videoResponse = await axios.get(mapped.video_url, config);
          downloadSuccess = true;
          break;
        } catch (err: any) {
          this.logger.warn(`Failed to download Pinterest video on attempt ${attempt}: ${err.message}`);
          lastErr = err;
          // Wait a bit before retry
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }

      if (!downloadSuccess) {
        throw lastErr || new Error('Failed to download video from Pinterest after 3 attempts');
      }
      const videoBuffer = Buffer.from(videoResponse.data);
      fs.writeFileSync(rawFile, videoBuffer);

      this.logger.log(`Re-encoding for compatibility if needed...`);
      const reencode = await this.shouldReencodeVideo(rawFile);
      if (reencode) {
        this.logger.log(`Re-encoding Pinterest video for compatibility...`);
        await new Promise<void>((resolve, reject) => {
          ffmpeg(rawFile as string)
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
              '-movflags +faststart',
              '-preset fast',
              '-crf 23',
              '-pix_fmt yuv420p',
            ])
            .save(finalFile as string)
            .on('end', () => resolve())
            .on('error', (err: Error) => reject(err));
        });
      } else {
        this.logger.log(`Pinterest video already compliant. Remuxing with stream copy...`);
        await new Promise<void>((resolve, reject) => {
          ffmpeg(rawFile as string)
            .outputOptions([
              '-c copy',
              '-movflags +faststart',
            ])
            .save(finalFile as string)
            .on('end', () => resolve())
            .on('error', (err: Error) => reject(err));
        });
      }

      try { fs.unlinkSync(rawFile); } catch { /* ignore */ }
      rawFile = null;

      if (!fs.existsSync(finalFile)) {
        throw new BadRequestException('Processed file does not exist');
      }

      const stat = fs.statSync(finalFile);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', stat.size.toString());
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Accept-Ranges', 'bytes');

      const stream = fs.createReadStream(finalFile);
      stream.pipe(res);

      const targetFile = finalFile;
      res.on('finish', () => { fs.unlink(targetFile, () => {}); });
      stream.on('error', () => { fs.unlink(targetFile, () => {}); });
    } catch (error: any) {
      if (rawFile && fs.existsSync(rawFile)) try { fs.unlinkSync(rawFile); } catch { /* */ }
      if (finalFile && fs.existsSync(finalFile)) try { fs.unlinkSync(finalFile); } catch { /* */ }
      if (error instanceof BadRequestException) throw error;
      const msg = error.message || String(error);
      this.logger.error(`Failed to download Pinterest video: ${msg}`, error);
      throw new BadRequestException(`Failed to download Pinterest video: ${msg}`);
    }
  }

  async downloadImage(url: string, res: Response) {
    let downloadedFile: string | null = null;
    try {
      const parsed = this.parseUrl(url);
      if (parsed.type !== 'pin' || !parsed.pinId) {
        throw new BadRequestException(
          'Please provide a single pin URL: https://www.pinterest.com/pin/123456/',
        );
      }

      this.logger.log(`Fetching Pinterest pin: ${parsed.pinId}`);
      const pinData = await this.getPinDetail(parsed.pinId);
      if (!pinData) throw new BadRequestException('Pin not found');

      const mapped = this.mapPinData(pinData);
      if (!mapped.image_url) {
        throw new BadRequestException('Cannot extract image URL from this pin.');
      }

      const title = mapped.title || mapped.description || 'pinterest_image';
      const sanitizedTitle =
        this.sanitizeFilename(title).substring(0, 50) || 'pinterest_image';

      const tempDir = os.tmpdir();
      downloadedFile = path.join(tempDir, `pinterest-img-${Date.now()}`);

      let imageResponse: any;
      let lastErr: any = null;
      let downloadSuccess = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const agent = this.proxyService.getProxyAgent();
          const config: any = {
            responseType: 'arraybuffer',
            headers: {
              'User-Agent': DEFAULT_HEADERS['User-Agent'],
              Referer: 'https://www.pinterest.com/',
            },
            timeout: 30000,
            httpsAgent: agent,
            httpAgent: agent,
          };
          this.logger.log(`Attempt ${attempt}: Downloading image via Proxy bridge`);

          imageResponse = await axios.get(mapped.image_url, config);
          downloadSuccess = true;
          break;
        } catch (err: any) {
          this.logger.warn(`Failed to download Pinterest image on attempt ${attempt}: ${err.message}`);
          lastErr = err;
        }
      }

      if (!downloadSuccess) {
        throw lastErr || new Error('Failed to download image from Pinterest after 3 attempts');
      }

      const contentType = imageResponse.headers['content-type'] || 'image/jpeg';
      let ext = 'jpg';
      if (contentType.includes('png') || mapped.image_url.endsWith('.png')) ext = 'png';
      else if (contentType.includes('gif') || mapped.image_url.endsWith('.gif')) ext = 'gif';
      else if (contentType.includes('webp') || mapped.image_url.endsWith('.webp')) ext = 'webp';

      const filename = `${sanitizedTitle}.${ext}`;
      downloadedFile += `.${ext}`;

      const buffer = Buffer.from(imageResponse.data);
      fs.writeFileSync(downloadedFile, buffer);

      const stat = fs.statSync(downloadedFile);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stat.size.toString());
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      const stream = fs.createReadStream(downloadedFile);
      stream.pipe(res);

      const targetFile = downloadedFile;
      res.on('finish', () => { fs.unlink(targetFile, () => {}); });
      stream.on('error', () => { fs.unlink(targetFile, () => {}); });
    } catch (error: any) {
      if (downloadedFile && fs.existsSync(downloadedFile)) try { fs.unlinkSync(downloadedFile); } catch { /* */ }
      if (error instanceof BadRequestException) throw error;
      const msg = error.message || String(error);
      this.logger.error(`Failed to download Pinterest image: ${msg}`, error);
      throw new BadRequestException(`Failed to download Pinterest image: ${msg}`);
    }
  }

  async downloadAudio(url: string, res: Response) {
    let rawFile: string | null = null;
    let finalFile: string | null = null;
    const ts = Date.now();
    try {
      const parsed = this.parseUrl(url);
      if (parsed.type !== 'pin' || !parsed.pinId) {
        throw new BadRequestException(
          'Please provide a single pin URL: https://www.pinterest.com/pin/123456/',
        );
      }

      this.logger.log(`Fetching Pinterest pin for audio: ${parsed.pinId}`);
      const pinData = await this.getPinDetail(parsed.pinId);
      if (!pinData) throw new BadRequestException('Pin not found');

      const mapped = this.mapPinData(pinData);
      if (!mapped.is_video || !mapped.video_url) {
        throw new BadRequestException(
          'This pin does not contain a video. Cannot extract audio from an image pin.',
        );
      }

      const title = mapped.title || mapped.description || 'pinterest_audio';
      const sanitizedTitle =
        this.sanitizeFilename(title).substring(0, 50) || 'pinterest_audio';
      const filename = `${sanitizedTitle}.mp3`;

      const tempDir = os.tmpdir();
      rawFile = path.join(tempDir, `pinterest-audio-${ts}-raw.mp4`);
      finalFile = path.join(tempDir, `pinterest-audio-${ts}-final.mp3`);

      this.logger.log(`Downloading video for audio extraction...`);
      let videoResponse: any;
      let lastErr: any = null;
      let downloadSuccess = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const agent = this.proxyService.getProxyAgent();
          const config: any = {
            responseType: 'arraybuffer',
            headers: {
              'User-Agent': DEFAULT_HEADERS['User-Agent'],
              Referer: 'https://www.pinterest.com/',
            },
            timeout: 30000,
            httpsAgent: agent,
            httpAgent: agent,
          };
          this.logger.log(`Attempt ${attempt}: Downloading audio via Proxy bridge`);

          videoResponse = await axios.get(mapped.video_url, config);
          downloadSuccess = true;
          break;
        } catch (err: any) {
          this.logger.warn(`Failed to download Pinterest audio on attempt ${attempt}: ${err.message}`);
          lastErr = err;
        }
      }

      if (!downloadSuccess) {
        throw lastErr || new Error('Failed to download audio from Pinterest after 3 attempts');
      }
      const videoBuffer = Buffer.from(videoResponse.data);
      fs.writeFileSync(rawFile, videoBuffer);

      this.logger.log(`Converting to MP3...`);
      await new Promise<void>((resolve, reject) => {
        ffmpeg(rawFile as string)
          .noVideo()
          .audioCodec('libmp3lame')
          .audioBitrate(192)
          .save(finalFile as string)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err));
      });

      try { fs.unlinkSync(rawFile); } catch { /* */ }
      rawFile = null;

      if (!fs.existsSync(finalFile)) {
        throw new BadRequestException('Converted audio file does not exist');
      }

      const stat = fs.statSync(finalFile);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', stat.size.toString());
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Accept-Ranges', 'bytes');

      const stream = fs.createReadStream(finalFile);
      stream.pipe(res);

      const targetFile = finalFile;
      res.on('finish', () => { fs.unlink(targetFile, () => {}); });
      stream.on('error', () => { fs.unlink(targetFile, () => {}); });
    } catch (error: any) {
      if (rawFile && fs.existsSync(rawFile)) try { fs.unlinkSync(rawFile); } catch { /* */ }
      if (finalFile && fs.existsSync(finalFile)) try { fs.unlinkSync(finalFile); } catch { /* */ }
      if (error instanceof BadRequestException) throw error;
      const msg = error.message || String(error);
      this.logger.error(`Failed to download Pinterest audio: ${msg}`, error);
      throw new BadRequestException(`Failed to download Pinterest audio: ${msg}`);
    }
  }

  private shouldReencodeVideo(filePath: string): Promise<boolean> {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          this.logger.warn(`ffprobe error: ${err.message}`);
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

  private sanitizeFilename(name: string): string {
    return name
      .replace(/[^a-zA-Z0-9\s\-_À-ɏḀ-ỿ]/g, '')
      .trim()
      .replace(/\s+/g, '_');
  }

  // ──────────────────────────────────────────────────────────
  // Pinterest OAuth2 & Accounts Management (JSON storage)
  // ──────────────────────────────────────────────────────────

  /**
   * Đọc danh sách tài khoản liên kết từ file JSON
   */
  private readAccounts(): PinterestAccount[] {
    try {
      if (!fs.existsSync(this.accountsFilePath)) {
        return [];
      }
      const data = fs.readFileSync(this.accountsFilePath, 'utf-8');
      return JSON.parse(data) as PinterestAccount[];
    } catch (error: any) {
      this.logger.error(`Failed to read accounts file: ${error.message}`);
      return [];
    }
  }

  /**
   * Ghi danh sách tài khoản liên kết vào file JSON
   */
  private writeAccounts(accounts: PinterestAccount[]): void {
    try {
      fs.writeFileSync(this.accountsFilePath, JSON.stringify(accounts, null, 2), 'utf-8');
    } catch (error: any) {
      this.logger.error(`Failed to write accounts file: ${error.message}`);
      throw new BadRequestException(`Failed to save accounts storage: ${error.message}`);
    }
  }

  /**
   * Sinh URL Authorization để Client chuyển hướng người dùng sang Pinterest đăng nhập
   */
  getAuthUrl() {
    const clientId = this.configService.get<string>('PINTEREST_CLIENT_ID');
    const redirectUri = this.configService.get<string>('PINTEREST_REDIRECT_URI');

    if (!clientId || !redirectUri) {
      throw new BadRequestException(
        'Missing PINTEREST_CLIENT_ID or PINTEREST_REDIRECT_URI in environment variables.',
      );
    }

    const state = Math.random().toString(36).substring(2, 15);
    // Danh sách các quyền (scopes) cần thiết để đăng Pin và đọc thông tin user
    const scopes = ['pins:read', 'pins:write', 'boards:read', 'user_accounts:read'].join(',');

    const url = `https://www.pinterest.com/oauth/?consumer_id=${clientId}&redirect_uri=${encodeURIComponent(
      redirectUri,
    )}&response_type=code&scope=${scopes}&state=${state}`;

    return { success: true, url, state };
  }

  /**
   * Đổi Authorization Code lấy Tokens, gọi API lấy thông tin profile và lưu trữ vào accounts.json
   */
  async handleAuthCallback(code: string) {
    const clientId = this.configService.get<string>('PINTEREST_CLIENT_ID');
    const clientSecret = this.configService.get<string>('PINTEREST_CLIENT_SECRET');
    const redirectUri = this.configService.get<string>('PINTEREST_REDIRECT_URI');

    if (!clientId || !clientSecret || !redirectUri) {
      throw new BadRequestException(
        'Missing Pinterest OAuth credentials (CLIENT_ID, CLIENT_SECRET, REDIRECT_URI) in env.',
      );
    }

    // 1. Gửi request đổi Code lấy Access & Refresh Token
    const tokenUrl = `${PINTEREST_V5_API}/oauth/token`;
    // Pinterest OAuth2 sử dụng Basic Auth Header (Base64 clientId:clientSecret)
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', redirectUri);

    let tokenData: any;
    try {
      const response = await axios.post(tokenUrl, params, {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      tokenData = response.data;
    } catch (error: any) {
      const detail = error.response?.data?.message || error.message;
      this.logger.error(`Failed to exchange auth code: ${JSON.stringify(error.response?.data)}`);
      throw new BadRequestException(`Failed to exchange Pinterest authorization code: ${detail}`);
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    // expires_in tính bằng giây (thường là 30 ngày)
    const expiresAt = Date.now() + (tokenData.expires_in || 2592000) * 1000;

    // 2. Gọi API Pinterest lấy thông tin cá nhân của User
    let userData: any;
    try {
      const userResponse = await axios.get(`${PINTEREST_V5_API}/user_account`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      userData = userResponse.data;
    } catch (error: any) {
      const detail = error.response?.data?.message || error.message;
      throw new BadRequestException(`Failed to fetch Pinterest user profile: ${detail}`);
    }

    const username = userData.username;
    if (!username) {
      throw new BadRequestException('Could not retrieve username from Pinterest response.');
    }

    // 3. Lưu trữ tài khoản vào JSON
    const accounts = this.readAccounts();
    const existingIndex = accounts.findIndex((acc) => acc.username === username);

    const newAccount: PinterestAccount = {
      username,
      fullName: userData.business_name || userData.username,
      avatarUrl: userData.profile_image || null,
      accessToken,
      refreshToken,
      expiresAt,
      connectedAt: Date.now(),
    };

    if (existingIndex > -1) {
      accounts[existingIndex] = newAccount;
      this.logger.log(`Updated existing Pinterest account connection for user: ${username}`);
    } else {
      accounts.push(newAccount);
      this.logger.log(`Added new Pinterest account connection for user: ${username}`);
    }

    this.writeAccounts(accounts);

    return {
      success: true,
      message: 'Account connected successfully.',
      account: {
        username: newAccount.username,
        fullName: newAccount.fullName,
        avatarUrl: newAccount.avatarUrl,
        connectedAt: newAccount.connectedAt,
      },
    };
  }

  /**
   * Gọi Pinterest OAuth làm mới token dựa trên Refresh Token
   */
  private async refreshAccessToken(account: PinterestAccount): Promise<PinterestAccount> {
    const clientId = this.configService.get<string>('PINTEREST_CLIENT_ID');
    const clientSecret = this.configService.get<string>('PINTEREST_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      throw new BadRequestException('Pinterest OAuth credentials are not configured in environment.');
    }

    const tokenUrl = `${PINTEREST_V5_API}/oauth/token`;
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', account.refreshToken);

    try {
      this.logger.log(`Refreshing access token for Pinterest account: ${account.username}`);
      const response = await axios.post(tokenUrl, params, {
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const tokenData = response.data;
      account.accessToken = tokenData.access_token;
      // update expiry time
      account.expiresAt = Date.now() + (tokenData.expires_in || 2592000) * 1000;

      // Nếu Pinterest trả về refresh_token mới thì lưu lại, nếu không thì giữ nguyên refresh_token cũ
      if (tokenData.refresh_token) {
        account.refreshToken = tokenData.refresh_token;
      }

      return account;
    } catch (error: any) {
      const detail = error.response?.data?.message || error.message;
      this.logger.error(
        `Failed to refresh access token for user ${account.username}: ${JSON.stringify(
          error.response?.data,
        )}`,
      );
      throw new BadRequestException(
        `Token refresh failed for account "${account.username}". Client may need to re-authenticate. Detail: ${detail}`,
      );
    }
  }

  /**
   * Lấy Access Token hợp lệ của User.
   * Nếu hết hạn hoặc sắp hết hạn (dưới 5 phút), tự động gia hạn trước khi trả về.
   */
  async getAccessTokenForUser(username: string): Promise<string> {
    const accounts = this.readAccounts();
    const accountIndex = accounts.findIndex((acc) => acc.username === username);

    if (accountIndex === -1) {
      throw new NotFoundException(`Pinterest account with username "${username}" not connected.`);
    }

    let account = accounts[accountIndex];
    const BUFFER_TIME = 5 * 60 * 1000; // 5 minutes buffer

    // Nếu token hết hạn hoặc sắp hết hạn
    if (Date.now() + BUFFER_TIME >= account.expiresAt) {
      try {
        account = await this.refreshAccessToken(account);
        accounts[accountIndex] = account;
        this.writeAccounts(accounts);
      } catch (err: any) {
        this.logger.error(`Auto refresh token failed for ${username}: ${err.message}`);
        throw new BadRequestException(
          `Pinterest token expired for "${username}" and refresh failed. Please re-authenticate.`,
        );
      }
    }

    return account.accessToken;
  }

  /**
   * Trả về danh sách kênh đã liên kết (Ẩn tokens)
   */
  getConnectedChannels() {
    const accounts = this.readAccounts();
    const sanitized = accounts.map((acc) => ({
      username: acc.username,
      fullName: acc.fullName,
      avatarUrl: acc.avatarUrl,
      connectedAt: acc.connectedAt,
      expiresAt: acc.expiresAt,
      isExpired: Date.now() >= acc.expiresAt,
    }));

    return {
      success: true,
      count: sanitized.length,
      channels: sanitized,
    };
  }

  /**
   * Hủy kết nối kênh Pinterest (Xóa khỏi JSON)
   */
  disconnectChannel(username: string) {
    const accounts = this.readAccounts();
    const filtered = accounts.filter((acc) => acc.username !== username);

    if (accounts.length === filtered.length) {
      throw new NotFoundException(`Pinterest account with username "${username}" was not found.`);
    }

    this.writeAccounts(filtered);
    this.logger.log(`Disconnected Pinterest account: ${username}`);

    return {
      success: true,
      message: `Pinterest account "${username}" has been disconnected.`,
    };
  }

  /**
   * Kiểm tra thủ công token có hoạt động hay không và còn bao nhiêu giây
   */
  async checkTokenStatus(username: string) {
    const accounts = this.readAccounts();
    const account = accounts.find((acc) => acc.username === username);

    if (!account) {
      throw new NotFoundException(`Pinterest account with username "${username}" not connected.`);
    }

    const isExpired = Date.now() >= account.expiresAt;
    const timeLeftSeconds = Math.max(0, Math.floor((account.expiresAt - Date.now()) / 1000));

    // Thực hiện test call nhỏ tới api Pinterest để kiểm tra xem token còn thực sự active hay không
    let isWorking = false;
    let errorMessage = '';

    try {
      await axios.get(`${PINTEREST_V5_API}/user_account`, {
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
        },
      });
      isWorking = true;
    } catch (error: any) {
      isWorking = false;
      errorMessage = error.response?.data?.message || error.message;
    }

    return {
      success: true,
      username,
      isExpired,
      timeLeftSeconds,
      isWorking,
      errorMessage: isWorking ? null : errorMessage,
    };
  }

  // ──────────────────────────────────────────────────────────
  // Pinterest v5 API: Scheduled Pin Posting
  // ──────────────────────────────────────────────────────────

  /**
   * Schedule a pin to be published at a future ISO 8601 timestamp.
   *
   * Creates a one-shot CronJob via SchedulerRegistry. When the
   * job fires it POSTs to the Pinterest v5 /pins endpoint, then
   * immediately deletes itself from the registry to free memory.
   */
  async schedulePin(dto: SchedulePinDto) {
    // Check if user account exists to fail fast
    await this.getAccessTokenForUser(dto.username);

    const fireDate = new Date(dto.scheduleTime);
    const jobName = `pin-${dto.boardId}-${fireDate.getTime()}`;

    // Guard: prevent duplicate jobs for the exact same board + time
    if (this.schedulerRegistry.doesExist('cron', jobName)) {
      throw new BadRequestException(
        `A scheduled pin already exists for board ${dto.boardId} at ${dto.scheduleTime}. ` +
          `Delete it first or choose a different time.`,
      );
    }

    const job = CronJob.from({
      cronTime: fireDate,
      onTick: async () => {
        this.logger.log(`[Scheduler] Firing scheduled pin job: ${jobName}`);
        try {
          // Lấy access token hợp lệ (nếu sắp hết hạn, getAccessTokenForUser sẽ tự refresh)
          const token = await this.getAccessTokenForUser(dto.username);
          const result = await this.postPinToV5Api(dto, token);
          this.logger.log(
            `[Scheduler] Pin posted successfully. Pin ID: ${result.id}`,
          );
        } catch (error: any) {
          this.logger.error(
            `[Scheduler] Failed to post pin for job "${jobName}": ${error.message}`,
            error.stack,
          );
        } finally {
          // One-shot: remove the job from the registry after execution
          this.schedulerRegistry.deleteCronJob(jobName);
          this.logger.log(`[Scheduler] Cleaned up job: ${jobName}`);
        }
      },
      start: false, // we start it explicitly after registration
      timeZone: 'UTC',
    });

    this.schedulerRegistry.addCronJob(jobName, job);
    job.start();

    this.logger.log(
      `[Scheduler] Registered job "${jobName}" — will fire at ${fireDate.toISOString()}`,
    );

    return {
      success: true,
      jobName,
      scheduledFor: fireDate.toISOString(),
      boardId: dto.boardId,
      title: dto.title,
    };
  }

  /**
   * POST a pin to the Pinterest v5 REST API.
   *
   * Endpoint: POST https://api.pinterest.com/v5/pins
   * Docs:     https://developers.pinterest.com/docs/api/v5/#tag/pins/post/pins
   */
  private async postPinToV5Api(
    dto: SchedulePinDto,
    bearerToken: string,
  ): Promise<{ id: string }> {
    const payload: Record<string, any> = {
      board_id: dto.boardId,
      title: dto.title,
      description: dto.description,
      media_source: {
        source_type: 'image_url',
        url: dto.imageUrl,
      },
    };

    // Attach optional fields only if provided
    if (dto.link) payload.link = dto.link;
    if (dto.altText) payload.alt_text = dto.altText;

    try {
      const response = await axios.post(`${PINTEREST_V5_API}/pins`, payload, {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      });

      return response.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        const detail =
          error.response?.data?.message ||
          error.response?.data?.error?.message ||
          error.message;

        this.logger.error(
          `Pinterest v5 API error [${status}]: ${JSON.stringify(error.response?.data)}`,
        );

        throw new BadRequestException(
          `Pinterest API responded with ${status}: ${detail}`,
        );
      }
      throw error;
    }
  }

  /**
   * List all currently-registered scheduled pin jobs.
   */
  getScheduledJobs() {
    const jobs = this.schedulerRegistry.getCronJobs();
    const result: { jobName: string; nextFireTime: string | null }[] = [];

    jobs.forEach((job, name) => {
      // Only include pin-scheduling jobs (not unrelated crons)
      if (name.startsWith('pin-')) {
        const next = job.nextDate();
        result.push({
          jobName: name,
          nextFireTime: next ? next.toISO() : null,
        });
      }
    });

    return { success: true, count: result.length, jobs: result };
  }

  /**
   * Cancel a scheduled pin job by its name and remove it
   * from the registry.
   */
  cancelScheduledJob(jobName: string) {
    if (!this.schedulerRegistry.doesExist('cron', jobName)) {
      throw new BadRequestException(
        `No scheduled job found with name "${jobName}"`,
      );
    }

    this.schedulerRegistry.deleteCronJob(jobName);
    this.logger.log(`[Scheduler] Cancelled and removed job: ${jobName}`);

    return { success: true, message: `Job "${jobName}" has been cancelled.` };
  }
}

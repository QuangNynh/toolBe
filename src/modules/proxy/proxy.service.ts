import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Server } from 'proxy-chain';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

@Injectable()
export class ProxyService implements OnModuleInit, OnModuleDestroy {
  private server: Server;
  private requestCount = 0;
  private ytdlpProxyIndex = 0;
  private proxyList: string[] = [];

  async onModuleInit() {
    // Load proxy list from env based on PROXY_COUNT
    this.proxyList = this.loadProxyList();

    if (this.proxyList.length > 0) {
      console.log(`Loaded ${this.proxyList.length} proxies for rotation:`);
      this.proxyList.forEach((p, i) => {
        // Mask credentials in log
        const masked = p.replace(/\/\/(.+?)@/, '//***:***@');
        console.log(`  Proxy ${i + 1}: ${masked}`);
      });
    } else {
      console.log('No proxies configured. Running without proxy.');
    }

    this.server = new Server({
      port: 8888,
      prepareRequestFunction: () => {
        this.requestCount++;
        const upstream = this.getProxy();
        return upstream ? { upstreamProxyUrl: upstream } : {};
      },
    });

    await this.server.listen();
    console.log('Proxy running at http://localhost:8888');
  }

  /**
   * Load proxies from env vars: YTDLP_PROXY_1, YTDLP_PROXY_2, ..., YTDLP_PROXY_N
   * N is determined by PROXY_COUNT env var.
   * If PROXY_COUNT is not set, auto-detect by scanning YTDLP_PROXY_* vars.
   */
  private loadProxyList(): string[] {
    const proxyCount = parseInt(process.env.PROXY_COUNT || '0', 10);
    const proxies: string[] = [];

    if (proxyCount > 0) {
      // Load exactly PROXY_COUNT proxies
      for (let i = 1; i <= proxyCount; i++) {
        const proxyUrl = process.env[`YTDLP_PROXY_${i}`]?.trim();
        if (
          proxyUrl &&
          !proxyUrl.includes('username:password') &&
          !proxyUrl.includes('ip:port')
        ) {
          proxies.push(proxyUrl);
        } else if (proxyUrl) {
          console.warn(
            `YTDLP_PROXY_${i} is a placeholder, skipping.`,
          );
        } else {
          console.warn(
            `YTDLP_PROXY_${i} is not set but PROXY_COUNT=${proxyCount}. Skipping.`,
          );
        }
      }
    } else {
      // Auto-detect: scan YTDLP_PROXY_1, YTDLP_PROXY_2, ... until not found
      let i = 1;
      while (true) {
        const proxyUrl = process.env[`YTDLP_PROXY_${i}`]?.trim();
        if (!proxyUrl) break;
        if (
          !proxyUrl.includes('username:password') &&
          !proxyUrl.includes('ip:port')
        ) {
          proxies.push(proxyUrl);
        }
        i++;
      }
    }

    return proxies;
  }

  getProxyAgent(): any {
    if (this.hasUpstreamProxy()) {
      return new HttpsProxyAgent(this.getProxyUrl());
    }
    return undefined;
  }

  private getProxy(): string | undefined {
    // Use the loaded proxy list with round-robin for upstream proxy server
    if (this.proxyList.length > 0) {
      const selected =
        this.proxyList[this.requestCount % this.proxyList.length];
      return selected;
    }

    // Fallback: check PROXIES env var (comma-separated)
    const envProxies = process.env.PROXIES;
    if (envProxies) {
      const list = envProxies
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      if (list.length > 0) {
        return list[Math.floor(Math.random() * list.length)];
      }
    }

    return undefined;
  }

  hasUpstreamProxy(): boolean {
    if (this.proxyList.length > 0) return true;

    const envProxies = process.env.PROXIES;
    if (envProxies) {
      return (
        envProxies
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean).length > 0
      );
    }
    return false;
  }

  getProxyUrl(): string {
    return 'http://127.0.0.1:8888';
  }

  getYtdlpProxy(): string | undefined {
    if (this.hasUpstreamProxy()) {
      return this.getProxyUrl();
    }

    if (process.env.YTDLP_PROXY) {
      return process.env.YTDLP_PROXY;
    }

    return undefined;
  }

  /**
   * Get current proxy stats for monitoring
   */
  getProxyStats() {
    return {
      totalProxies: this.proxyList.length,
      totalRequests: this.requestCount,
      currentYtdlpIndex: this.ytdlpProxyIndex % (this.proxyList.length || 1),
      proxies: this.proxyList.map((p, i) => ({
        index: i + 1,
        url: p.replace(/\/\/(.+?)@/, '//***:***@'),
      })),
    };
  }

  async onModuleDestroy() {
    await this.server?.close(true);
  }
}

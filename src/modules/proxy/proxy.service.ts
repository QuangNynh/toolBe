import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Server } from 'proxy-chain';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

@Injectable()
export class ProxyService implements OnModuleInit, OnModuleDestroy {
  private server: Server;
  private requestCount = 0;

  async onModuleInit() {
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

  getProxyAgent(): any {
    const ytdlpProxy = process.env.YTDLP_PROXY;
    if (ytdlpProxy) {
      if (ytdlpProxy.startsWith('socks')) {
        return new SocksProxyAgent(ytdlpProxy);
      }
      return new HttpsProxyAgent(ytdlpProxy);
    }
    if (this.hasUpstreamProxy()) {
      return new HttpsProxyAgent(this.getProxyUrl());
    }
    return undefined;
  }

  private getProxy(): string | undefined {
    const envProxies = process.env.PROXIES;
    if (envProxies) {
      const list = envProxies.split(',').map((p) => p.trim()).filter(Boolean);
      if (list.length > 0) {
        return list[Math.floor(Math.random() * list.length)];
      }
    }

    const proxies = ['http://user:pass@ip1:port', 'http://user:pass@ip2:port'];
    const selected = proxies[Math.floor(Math.random() * proxies.length)];
    if (selected.includes('ip1:port') || selected.includes('ip2:port')) {
      return undefined;
    }
    return selected;
  }

  hasUpstreamProxy(): boolean {
    const envProxies = process.env.PROXIES;
    if (envProxies) {
      return envProxies.split(',').map((p) => p.trim()).filter(Boolean).length > 0;
    }
    return false;
  }

  getProxyUrl(): string {
    return 'http://localhost:8888';
  }

  getYtdlpProxy(): string | undefined {
    if (process.env.YTDLP_PROXY) {
      return process.env.YTDLP_PROXY;
    }
    if (this.hasUpstreamProxy()) {
      return this.getProxyUrl();
    }
    return undefined;
  }

  async onModuleDestroy() {
    await this.server?.close(true);
  }
}

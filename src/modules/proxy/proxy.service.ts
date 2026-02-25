import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Server } from 'proxy-chain';

@Injectable()
export class ProxyService implements OnModuleInit, OnModuleDestroy {
  private server: Server;
  private requestCount = 0;

  async onModuleInit() {
    this.server = new Server({
      port: 8888,
      prepareRequestFunction: () => {
        this.requestCount++;

        return {
          upstreamProxyUrl: this.getProxy(),
        };
      },
    });

    await this.server.listen();
    console.log('Proxy running at http://localhost:8888');
  }

  private getProxy(): string {
    const proxies = ['http://user:pass@ip1:port', 'http://user:pass@ip2:port'];

    return proxies[Math.floor(Math.random() * proxies.length)];
  }

  getProxyUrl(): string {
    return 'http://localhost:8888';
  }

  async onModuleDestroy() {
    await this.server?.close(true);
  }
}

import { Module } from '@nestjs/common';
import { TiktokController } from './tiktok.controller';
import { TiktokService } from './tiktok.service';
import { ProxyModule } from '../proxy/proxy.module';

@Module({
  imports: [ProxyModule],
  controllers: [TiktokController],
  providers: [TiktokService],
  exports: [TiktokService],
})
export class TiktokModule {}

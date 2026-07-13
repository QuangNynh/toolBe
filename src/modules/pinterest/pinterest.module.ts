import { Module } from '@nestjs/common';
import { PinterestController } from './pinterest.controller';
import { PinterestService } from './pinterest.service';
import { ProxyModule } from '../proxy/proxy.module';

@Module({
  imports: [ProxyModule],
  controllers: [PinterestController],
  providers: [PinterestService],
  exports: [PinterestService],
})
export class PinterestModule {}

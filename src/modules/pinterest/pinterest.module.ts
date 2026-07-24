import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PinterestController } from './pinterest.controller';
import { PinterestService } from './pinterest.service';
import { ProxyModule } from '../proxy/proxy.module';

@Module({
  imports: [
    ProxyModule,
    ScheduleModule.forRoot(), // enables SchedulerRegistry + cron support
  ],
  controllers: [PinterestController],
  providers: [PinterestService],
  exports: [PinterestService],
})
export class PinterestModule {}

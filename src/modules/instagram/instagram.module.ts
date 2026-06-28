import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { ProxyModule } from '../proxy/proxy.module';
import { InstagramController } from './instagram.controller';
import { InstagramService } from './instagram.service';

@Module({
  imports: [MediaModule, ProxyModule],
  controllers: [InstagramController],
  providers: [InstagramService],
  exports: [InstagramService],
})
export class InstagramModule {}

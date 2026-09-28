import { Global, Module } from '@nestjs/common';

import { FragmentService } from './fragment.service';
import { Http2Client } from './http2';
import { MarketsRegistry } from './markets.registry';
import { MrktService } from './mrkt.service';
import { RateLimiterService } from './rate-limiter';
import { PortalsService } from './portals.service';
import { TelegramMarketService } from './telegram-market.service';
import { TonnelService } from './tonnel.service';

@Global()
@Module({
  providers: [
    Http2Client,
    RateLimiterService,
    MrktService,
    PortalsService,
    FragmentService,
    TelegramMarketService,
    TonnelService,
    MarketsRegistry,
  ],
  exports: [
    Http2Client,
    RateLimiterService,
    MrktService,
    PortalsService,
    FragmentService,
    TelegramMarketService,
    TonnelService,
    MarketsRegistry,
  ],
})
export class MarketsModule {}

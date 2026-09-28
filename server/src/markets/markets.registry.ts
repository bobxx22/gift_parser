import { Injectable } from '@nestjs/common';

import { MarketClient, MarketKey } from '../common/types';
import { FragmentService } from './fragment.service';
import { MrktService } from './mrkt.service';
import { PortalsService } from './portals.service';
import { TelegramMarketService } from './telegram-market.service';
import { TonnelService } from './tonnel.service';

export interface SourceInfo {
  key: MarketKey;
  title: string;
  history: boolean;
  listings: boolean;
  needsLogin: boolean;
  note: string;
}

/** Единая точка доступа ко всем площадкам. */
@Injectable()
export class MarketsRegistry {
  private readonly clients: Record<MarketKey, MarketClient>;

  constructor(
    readonly mrkt: MrktService,
    readonly portals: PortalsService,
    readonly fragment: FragmentService,
    readonly telegram: TelegramMarketService,
    readonly tonnel: TonnelService,
  ) {
    this.clients = { mrkt, portals, fragment, telegram, tonnel };
  }

  get(key: MarketKey): MarketClient | null {
    return this.clients[key] ?? null;
  }

  all(): MarketClient[] {
    return Object.values(this.clients);
  }

  keys(): MarketKey[] {
    return Object.keys(this.clients) as MarketKey[];
  }

  info(): SourceInfo[] {
    return this.all().map((client) => ({
      key: client.key,
      title: client.title,
      history: client.providesHistory,
      listings: client.providesListings,
      needsLogin: client.needsLogin,
      note: client.note ?? '',
    }));
  }
}

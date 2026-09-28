/**
 * Tonnel Network — gifts3.tonnel.network (запасной хост gifts2).
 *
 *   POST /api/saleHistory  {authData, page, limit<=50, type:"", filter:{...}, sort:{...}}
 *   POST /api/pageGifts    {page, limit, sort:"<json>", filter:"<json>", ref, user_auth}
 *
 * Тонкости: у saleHistory filter/sort — объекты, у pageGifts — строки с JSON;
 * `type: ""` = все события, в ответе тип INTERNAL_SALE (сделка) или BID (ставка);
 * атрибуты лежат вместе с редкостью — «Bengal Tiger (2.5%)».
 */

import { Injectable } from '@nestjs/common';

import { Filters, HistoryOptions, MarketClient, MarketKey, TradeEvent } from '../common/types';
import { parseTs, sleep, toNumber } from '../common/utils';
import { TelegramService } from '../telegram/telegram.service';
import { MarketError } from './http';
import { Http2Client } from './http2';
import { RateLimiterService } from './rate-limiter';
import { matches, round } from './mrkt.service';

const HOSTS = ['https://gifts3.tonnel.network', 'https://gifts2.tonnel.network'];
const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/128.0.0.0 Mobile Safari/537.36',
  origin: 'https://marketplace.tonnel.network',
  referer: 'https://marketplace.tonnel.network/',
};

const KIND_MAP: Record<string, string> = {
  INTERNAL_SALE: 'sale',
  EXTERNAL_SALE: 'sale',
  AUCTION_SALE: 'sale',
  SALE: 'sale',
  PURCHASE: 'sale',
  LUCKY_BUY: 'lucky_buy',
  BID: 'bid',
  LISTING: 'listing',
  OFFER: 'offer',
};

@Injectable()
export class TonnelService implements MarketClient {
  readonly key: MarketKey = 'tonnel';
  readonly title = 'Tonnel';
  readonly providesHistory = true;
  readonly providesListings = true;
  readonly needsLogin = true;
  readonly note = 'ставки на аукционах (BID) продажами не считаются';

  private host = HOSTS[0];

  constructor(
    private readonly telegram: TelegramService,
    private readonly http2: Http2Client,
    private readonly limiter: RateLimiterService,
  ) {}

  private async post<T>(path: string, body: Record<string, unknown>, retry = true): Promise<T> {
    const hosts = [this.host, ...HOSTS.filter((host) => host !== this.host)];
    const errors: string[] = [];
    for (const host of hosts) {
      let status: number;
      let data: T;
      try {
        // Через HTTP/2 с браузерными шифрами — иначе Cloudflare отдаёт «Just a moment…».
        ({ status, data } = await this.limiter.run(this.key, () =>
          this.http2.postJson<T>(host, path, body, BROWSER_HEADERS),
        ));
      } catch (error) {
        errors.push(`${host}: ${String((error as Error).message)}`);
        continue;
      }
      if (status === 403) {
        errors.push(`${host}: 403 Cloudflare`);
        continue;
      }
      if ((status === 401 || status === 419) && retry) {
        const fresh = await this.telegram.initData('tonnel', true);
        const next = { ...body };
        if ('authData' in next) next.authData = fresh;
        if ('user_auth' in next) next.user_auth = fresh;
        return this.post<T>(path, next, false);
      }
      if (status !== 200) {
        errors.push(`${host}: ${status}`);
        continue;
      }
      this.host = host;
      return data;
    }
    throw new MarketError(`Tonnel ${path} -> ${errors.join('; ')}`);
  }

  /** В базе значения вида «Bengal Tiger (2.5%)» — цепляемся за начало строки. */
  private attrFilter(value?: string | null): Record<string, string> | null {
    if (!value) return null;
    return { $regex: `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` };
  }

  private filter(filters: Filters): Record<string, unknown> {
    const query: Record<string, unknown> = {};
    if (filters.collection) query.gift_name = filters.collection;
    const pairs: Array<[string, string | null | undefined]> = [
      ['model', filters.model],
      ['backdrop', filters.backdrop],
      ['symbol', filters.symbol],
    ];
    for (const [field, value] of pairs) {
      const condition = this.attrFilter(value);
      if (condition) query[field] = condition;
    }
    if (filters.number) query.gift_num = filters.number;
    const price = this.priceFilter(filters);
    if (price) query.price = price;
    return query;
  }

  /** Диапазон цены в стиле монго-фильтра Tonnel. */
  private priceFilter(filters: Filters): Record<string, number> | null {
    const price: Record<string, number> = {};
    if (filters.minPrice != null) price.$gte = filters.minPrice;
    if (filters.maxPrice != null) price.$lte = filters.maxPrice;
    return Object.keys(price).length ? price : null;
  }

  async *historyPages(filters: Filters, options: HistoryOptions = {}): AsyncGenerator<TradeEvent[]> {
    const onlySales = options.onlySales ?? true;
    const limit = Math.min(options.pageSize ?? 20, 50);
    const authData = await this.telegram.initData('tonnel');
    let page = 1;
    while (true) {
      const items = await this.post<Array<Record<string, any>>>('/api/saleHistory', {
        authData,
        page,
        limit,
        type: '',
        filter: this.filter(filters),
        sort: { timestamp: -1, gift_id: -1 },
      });
      if (!Array.isArray(items) || !items.length) return;
      const events = items
        .map((item) => this.toEvent(item))
        .filter((event): event is TradeEvent => Boolean(event))
        .filter((event) => (onlySales ? event.kind === 'sale' : true))
        .filter((event) => matches(filters, event));
      if (events.length) yield events;
      if (items.length < limit) return;
      page += 1;
      await sleep(150);
    }
  }

  async listings(filters: Filters, limit = 30): Promise<TradeEvent[]> {
    const query = {
      ...this.filter(filters),
      buyer: { $exists: false },
      price: { $exists: true, ...(this.priceFilter(filters) ?? {}) },
    };
    let userAuth = '';
    try {
      userAuth = await this.telegram.initData('tonnel');
    } catch {
      userAuth = '';
    }
    const pageSize = 30;
    const lots: TradeEvent[] = [];
    for (let page = 1; lots.length < limit && page <= 4; page += 1) {
      const items = await this.post<Array<Record<string, any>>>('/api/pageGifts', {
        page,
        limit: pageSize,
        sort: JSON.stringify({ price: 1, gift_id: -1 }),
        filter: JSON.stringify(query),
        ref: '',
        user_auth: userAuth,
      });
      if (!Array.isArray(items) || !items.length) break;
      for (const item of items) {
        const event = this.toEvent(item, 'active_listing');
        if (event) lots.push(event);
      }
      if (items.length < pageSize) break;
      await sleep(120);
    }
    return lots.sort((a, b) => a.priceTon - b.priceTon).slice(0, limit);
  }

  private cleanAttr(value: unknown): string | null {
    if (!value) return null;
    return String(value).split(' (')[0].trim() || null;
  }

  private toEvent(item: Record<string, any>, kind?: string): TradeEvent | null {
    if (!item || typeof item !== 'object') return null;
    if (String(item.asset ?? 'TON').toUpperCase() !== 'TON') return null;
    const priceTon = toNumber(item.price);
    const collection = item.gift_name ?? item.name ?? '';
    if (priceTon <= 0 || !collection) return null;
    const rawKind = String(item.type ?? '').toUpperCase();
    const number = item.gift_num ?? item.number;
    return {
      market: this.title,
      kind: kind ?? KIND_MAP[rawKind] ?? rawKind.toLowerCase() ?? 'unknown',
      collection: String(collection),
      model: this.cleanAttr(item.model),
      backdrop: this.cleanAttr(item.backdrop),
      symbol: this.cleanAttr(item.symbol),
      number: Number.isFinite(Number(number)) ? Number(number) : null,
      priceTon: round(priceTon),
      ts: parseTs(item.timestamp ?? item.export_at),
      giftName: null,
      externalId: item.gift_id ? `${item.gift_id}-${item.timestamp ?? ''}` : null,
    };
  }
}

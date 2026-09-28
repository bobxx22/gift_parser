/**
 * Portals — portal-market.com/api
 *
 *   GET /collections                 -> коллекции (публично)
 *   GET /collections/filters         -> модели/фоны/символы + флор (публично)
 *   GET /nfts/search                 -> активные лоты (публично)
 *   GET /market/actions/             -> история рынка (нужен токен)
 *
 * Авторизация — заголовок `Authorization: tma <initData>`. Цены строками в TON.
 */

import { Injectable } from '@nestjs/common';
import { AxiosInstance } from 'axios';

import { Filters, HistoryOptions, MarketClient, MarketKey, TradeEvent } from '../common/types';
import { parseTs, sleep, toNumber } from '../common/utils';
import { TelegramService } from '../telegram/telegram.service';
import { MarketError, createHttp, requestWithRetry } from './http';
import { RateLimiterService } from './rate-limiter';
import { matches, round } from './mrkt.service';

const KIND_MAP: Record<string, string> = {
  purchase: 'sale',
  buy: 'sale',
  sale: 'sale',
  sell: 'sale',
  lucky_buy: 'lucky_buy',
  lucky_buy_win: 'lucky_buy',
  premarket_sale: 'sale',
  listing: 'listing',
  price_update: 'price_update',
  unlisting: 'unlisting',
  delist: 'unlisting',
  return: 'return',
  offer: 'offer',
};

/** Сделка может прилететь как buy или sell — тип перепроверяем локально. */
const SALE_ACTION_TYPES = ['buy', 'sell'];
/** Сколько ждём страницу истории, прежде чем отдать управление другим площадкам. */
const HISTORY_TIMEOUT_MS = 12_000;

export interface PortalsCollection {
  id: string;
  name: string;
  short_name: string;
  photo_url?: string;
  floor_price?: string;
  volume?: string;
  day_volume?: string;
  supply?: number;
  listed_count?: number;
  is_new?: boolean;
}

export interface PortalsAttribute {
  name: string;
  url?: string;
  floor_price?: string;
  supply?: number;
  rarity_per_mille?: number;
  rarityPermille?: number;
}

@Injectable()
export class PortalsService implements MarketClient {
  readonly key: MarketKey = 'portals';
  readonly title = 'Portals';
  readonly providesHistory = true;
  readonly providesListings = true;
  readonly needsLogin = true;

  private readonly http: AxiosInstance;
  private collectionsCache: { items: PortalsCollection[]; ts: number } | null = null;

  constructor(
    private readonly telegram: TelegramService,
    private readonly limiter: RateLimiterService,
  ) {
    this.http = createHttp('https://portal-market.com/api', {
      Origin: 'https://portal-market.com',
      Referer: 'https://portal-market.com/',
    });
  }

  // ------------------------------------------------------------------ auth
  private async authorize(force = false): Promise<void> {
    const initData = await this.telegram.initData('portals', force);
    this.http.defaults.headers.common.Authorization = `tma ${initData}`;
  }

  private async call<T>(
    url: string,
    params: Record<string, unknown>,
    needAuth: boolean,
    retry = true,
    options: { timeout?: number; attempts?: number } = {},
  ): Promise<T> {
    if (needAuth && !this.http.defaults.headers.common.Authorization) await this.authorize();
    const clean = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== null && value !== undefined && value !== ''),
    );
    const { status, data } = await this.limiter.run(this.key, () =>
      requestWithRetry<T>(
        this.http,
        { method: 'GET', url, params: clean, ...(options.timeout ? { timeout: options.timeout } : {}) },
        `Portals ${url}`,
        options.attempts ?? 2,
      ),
    );
    if (status === 429) this.limiter.penalize(this.key, 8000);
    if ((status === 401 || status === 403) && needAuth && retry) {
      await this.authorize(true);
      return this.call<T>(url, params, needAuth, false, options);
    }
    if (status !== 200) {
      throw new MarketError(`Portals ${url} -> ${status}: ${JSON.stringify(data).slice(0, 200)}`, status);
    }
    return data;
  }

  // ----------------------------------------------------------- справочники
  async collections(refresh = false): Promise<PortalsCollection[]> {
    if (!refresh && this.collectionsCache && Date.now() - this.collectionsCache.ts < 6 * 3600_000) {
      return this.collectionsCache.items;
    }
    const items: PortalsCollection[] = [];
    let offset = 0;
    while (true) {
      const data = await this.call<{ collections?: PortalsCollection[] }>(
        '/collections',
        { limit: 200, offset },
        false,
      );
      const chunk = data?.collections ?? [];
      items.push(...chunk);
      if (chunk.length < 200) break;
      offset += chunk.length;
      if (offset > 5000) break;
    }
    this.collectionsCache = { items, ts: Date.now() };
    return items;
  }

  async findCollection(name: string): Promise<PortalsCollection | null> {
    if (!name) return null;
    const target = name.trim().toLowerCase();
    const flat = target.replace(/[^a-z0-9]/g, '');
    const items = await this.collections();
    return (
      items.find((item) => item.name?.trim().toLowerCase() === target) ??
      items.find((item) => item.short_name === flat) ??
      null
    );
  }

  /** Модели/фоны/символы с их флором — публичный роут, работает без входа. */
  async attributes(shortNames: string[]): Promise<
    Record<string, { models: PortalsAttribute[]; backdrops: PortalsAttribute[]; symbols: PortalsAttribute[] }>
  > {
    const data = await this.call<{
      collections?: Record<string, { models?: PortalsAttribute[]; backdrops?: PortalsAttribute[]; symbols?: PortalsAttribute[] }>;
    }>('/collections/filters', { short_names: shortNames.join(',') }, false);
    const out: Record<string, { models: PortalsAttribute[]; backdrops: PortalsAttribute[]; symbols: PortalsAttribute[] }> = {};
    for (const [short, block] of Object.entries(data?.collections ?? {})) {
      if (!short) continue;
      out[short] = {
        models: block?.models ?? [],
        backdrops: block?.backdrops ?? [],
        symbols: block?.symbols ?? [],
      };
    }
    return out;
  }

  // ------------------------------------------------------------------ лента
  async *historyPages(filters: Filters, options: HistoryOptions = {}): AsyncGenerator<TradeEvent[]> {
    const onlySales = options.onlySales ?? true;
    const pageSize = Math.min(options.pageSize ?? 20, 50);
    const collection = await this.findCollection(filters.collection);
    if (!collection) throw new MarketError(`Portals: коллекция «${filters.collection}» не найдена`);

    const base: Record<string, unknown> = {
      collection_ids: collection.id,
      filter_by_models: filters.model ?? null,
      filter_by_backdrops: filters.backdrop ?? null,
      filter_by_symbols: filters.symbol ?? null,
      min_price: filters.minPrice ?? null,
      max_price: filters.maxPrice ?? null,
    };
    if (onlySales) base.action_types = SALE_ACTION_TYPES.join(',');

    let offset = 0;
    let dropActionTypes = false;
    let emptyPages = 0;
    const seen = new Set<string>();

    while (true) {
      const params: Record<string, unknown> = { ...base, offset, limit: pageSize };
      if (dropActionTypes) delete params.action_types;
      let data: { actions?: Array<Record<string, any>> };
      try {
        // История у Portals кешируется на их стороне: «холодный» запрос может
        // висеть десятки секунд, поэтому ждём недолго и не повторяем.
        data = await this.call<{ actions?: Array<Record<string, any>> }>('/market/actions/', params, true, true, {
          timeout: HISTORY_TIMEOUT_MS,
          attempts: 1,
        });
      } catch (error) {
        if (!dropActionTypes && base.action_types) {
          // Бэкенд не принял фильтр — берём всё и отсеиваем локально.
          dropActionTypes = true;
          continue;
        }
        throw error;
      }
      const actions = data?.actions ?? [];
      if (!actions.length) return;
      offset += actions.length;

      const page: TradeEvent[] = [];
      for (const action of actions) {
        const event = this.toEvent(action);
        if (!event) continue;
        const key = `${action.created_at}-${event.number}-${event.priceTon}-${event.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (onlySales && event.kind !== 'sale') continue;
        if (!matches(filters, event)) continue;
        page.push(event);
      }
      if (page.length) {
        emptyPages = 0;
        yield page;
      } else if ((emptyPages += 1) >= 2) {
        // Отдаём управление: пусть остальные площадки не ждут, продолжим при прокрутке.
        emptyPages = 0;
        yield [];
      }
      if (actions.length < pageSize) return;
      await sleep(100);
    }
  }

  // ---------------------------------------------------------------- витрина
  async listings(filters: Filters, limit = 30): Promise<TradeEvent[]> {
    const collection = await this.findCollection(filters.collection);
    if (!collection) throw new MarketError(`Portals: коллекция «${filters.collection}» не найдена`);
    const pageSize = 50;
    const lots: TradeEvent[] = [];
    for (let offset = 0; lots.length < limit && offset < pageSize * 4; offset += pageSize) {
      const data = await this.call<{ results?: Array<Record<string, any>> }>(
        '/nfts/search',
        {
          offset,
          limit: pageSize,
          collection_ids: collection.id,
          filter_by_models: filters.model ?? null,
          filter_by_backdrops: filters.backdrop ?? null,
          filter_by_symbols: filters.symbol ?? null,
          min_price: filters.minPrice ?? null,
          max_price: filters.maxPrice ?? null,
          status: 'listed',
          sort_by: 'price asc',
          exclude_bundled: 'true',
        },
        false,
      );
      const results = data?.results ?? [];
      if (!results.length) break;
      for (const nft of results) {
        const event = this.nftToEvent(nft, 'active_listing', nft.price);
        if (event && matches(filters, event)) lots.push(event);
      }
      if (results.length < pageSize) break;
    }
    return lots.sort((a, b) => a.priceTon - b.priceTon).slice(0, limit);
  }

  // ------------------------------------------------------------ нормализация
  private attrs(nft: Record<string, any>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const attribute of nft?.attributes ?? []) {
      const kind = String(attribute?.type ?? '').toLowerCase();
      if (kind) out[kind] = attribute.value;
    }
    return out;
  }

  private toEvent(action: Record<string, any>): TradeEvent | null {
    const nft = action?.nft;
    if (!nft) return null;
    const rawKind = String(action.type ?? '').toLowerCase();
    return this.nftToEvent(nft, KIND_MAP[rawKind] ?? rawKind ?? 'unknown', action.amount, action.created_at, action.old_price);
  }

  private nftToEvent(
    nft: Record<string, any>,
    kind: string,
    price: unknown,
    ts?: string,
    oldPrice?: unknown,
  ): TradeEvent | null {
    if (!nft) return null;
    const attrs = this.attrs(nft);
    return {
      market: this.title,
      kind,
      collection: String(nft.name ?? ''),
      model: attrs.model ?? null,
      backdrop: attrs.backdrop ?? null,
      symbol: attrs.symbol ?? null,
      number: nft.external_collection_number ?? null,
      priceTon: round(toNumber(price)),
      ts: parseTs(ts ?? nft.listed_at ?? nft.updated_at),
      giftName: nft.tg_id ?? null,
      oldPrice: oldPrice ? round(toNumber(oldPrice)) : null,
      externalId: nft.id ? `${nft.id}-${ts ?? ''}` : null,
    };
  }
}

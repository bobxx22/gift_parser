/**
 * MRKT — api.tgmrkt.io
 *
 *   POST /api/v1/auth          {"data": initData, "appId": null} -> {"token"}
 *   POST /api/v1/feed          {"count", "cursor", <фильтры>}    -> лента рынка
 *   POST /api/v1/gifts/saling  {"count", "cursor", <фильтры>}    -> активные лоты
 *
 * Авторизация — заголовок `Authorization: <token>` (без Bearer). Цены в nanoTON.
 */

import { Injectable, Logger } from '@nestjs/common';
import { AxiosInstance } from 'axios';

import {
  Filters,
  HistoryOptions,
  MarketClient,
  MarketKey,
  TradeEvent,
  inPriceRange,
} from '../common/types';
import { parseTs, sameAttr, sleep, toNumber } from '../common/utils';
import { TelegramService } from '../telegram/telegram.service';
import { MarketAuthError, MarketError, createHttp, requestWithRetry } from './http';
import { RateLimiterService } from './rate-limiter';

const NANO = 1_000_000_000;

/**
 * Значения enum-а фильтра ленты (из бандла мини-аппа). LuckyBuySale не берём:
 * в таком событии `amount` — цена билета розыгрыша (0,04 TON при медиане 3,9),
 * а не цена подарка.
 */
const SALE_FEED_TYPES = ['Sale', 'PremarketSale'];

const KIND_MAP: Record<string, string> = {
  sale: 'sale',
  premarket_sale: 'sale',
  lucky_buy: 'lucky_buy',
  lucky_buy_sale: 'lucky_buy',
  lucky_buy_win: 'lucky_buy',
  purchase: 'sale',
  listing: 'listing',
  premarket_listing: 'listing',
  change_price: 'price_update',
  unlisting: 'unlisting',
  return: 'return',
  crafting: 'crafting',
};

@Injectable()
export class MrktService implements MarketClient {
  readonly key: MarketKey = 'mrkt';
  readonly title = 'MRKT';
  readonly providesHistory = true;
  readonly providesListings = true;
  readonly needsLogin = true;

  private readonly logger = new Logger(MrktService.name);
  private readonly http: AxiosInstance;
  private token: string | null = null;

  constructor(
    private readonly telegram: TelegramService,
    private readonly limiter: RateLimiterService,
  ) {
    this.http = createHttp('https://api.tgmrkt.io/api/v1', {
      Origin: 'https://cdn.tgmrkt.io',
      Referer: 'https://cdn.tgmrkt.io/',
    });
  }

  // ------------------------------------------------------------------ auth
  async authorize(force = false): Promise<string> {
    const initData = await this.telegram.initData('mrkt', force);
    const { status, data } = await requestWithRetry<{ token?: string }>(
      this.http,
      { method: 'POST', url: '/auth', data: { data: initData, appId: null } },
      'MRKT /auth',
    );
    if (status !== 200 || !data?.token) {
      throw new MarketAuthError(`MRKT /auth -> ${status}: ${JSON.stringify(data).slice(0, 160)}`);
    }
    this.token = data.token;
    this.http.defaults.headers.common.Authorization = data.token;
    return data.token;
  }

  private async call<T>(url: string, body: unknown, retry = true): Promise<T> {
    if (!this.token) await this.authorize();
    const { status, data } = await this.limiter.run(this.key, () =>
      requestWithRetry<T>(this.http, { method: 'POST', url, data: body }, `MRKT ${url}`),
    );
    if ((status === 401 || status === 403) && retry) {
      await this.authorize(true);
      return this.call<T>(url, body, false);
    }
    if (status === 429) this.limiter.penalize(this.key, 5000);
    if (status !== 200) {
      throw new MarketError(`MRKT ${url} -> ${status}: ${JSON.stringify(data).slice(0, 200)}`, status);
    }
    return data;
  }

  private async get<T>(url: string, retry = true): Promise<T> {
    if (!this.token) await this.authorize();
    const { status, data } = await this.limiter.run(this.key, () =>
      requestWithRetry<T>(this.http, { method: 'GET', url }, `MRKT ${url}`),
    );
    if ((status === 401 || status === 403) && retry) {
      await this.authorize(true);
      return this.get<T>(url, false);
    }
    if (status !== 200) throw new MarketError(`MRKT ${url} -> ${status}`, status);
    return data;
  }

  // ----------------------------------------------------------- справочники
  /** Часть коллекций MRKT отдаёт без названия — только id; такие прячем. */
  async collectionNames(): Promise<string[]> {
    const rows = await this.get<Array<{ name?: string; title?: string }>>('/gifts/collections');
    const names = new Set<string>();
    for (const row of rows ?? []) {
      const name = row.title || row.name;
      if (name && !/^\d+$/.test(name) && name.length <= 40) names.add(name);
    }
    return [...names].sort();
  }

  /**
   * Флоры всех коллекций одним запросом — `/gifts/collections` отдаёт список
   * с `floorPriceNanoTons`, поэтому снимок рынка стоит ровно один вызов.
   */
  async collectionFloors(): Promise<Array<{ name: string; floorTon: number; volume: number | null }>> {
    const rows = await this.get<
      Array<{
        name?: string;
        title?: string;
        floorPriceNanoTons?: number | string | null;
        volume?: number | string | null;
        isHidden?: boolean;
      }>
    >('/gifts/collections');
    const out: Array<{ name: string; floorTon: number; volume: number | null }> = [];
    for (const row of rows ?? []) {
      const name = row.title || row.name;
      if (!name || row.isHidden || /^\d+$/.test(name)) continue;
      const floorTon = round(toNumber(row.floorPriceNanoTons) / NANO);
      if (!floorTon) continue;
      out.push({ name, floorTon, volume: row.volume != null ? toNumber(row.volume) : null });
    }
    return out;
  }

  // ------------------------------------------------------------------ лента
  private feedFilters(filters: Filters, types: string[]): Record<string, unknown> {
    return {
      collectionNames: filters.collection ? [filters.collection] : [],
      modelNames: filters.model ? [filters.model] : [],
      backdropNames: filters.backdrop ? [filters.backdrop] : [],
      number: filters.number ?? null,
      type: types,
      minPrice: filters.minPrice ? Math.round(filters.minPrice * NANO) : null,
      maxPrice: filters.maxPrice ? Math.round(filters.maxPrice * NANO) : null,
    };
  }

  async *historyPages(filters: Filters, options: HistoryOptions = {}): AsyncGenerator<TradeEvent[]> {
    const onlySales = options.onlySales ?? true;
    const pageSize = Math.min(options.pageSize ?? 20, 100);
    // Если бэкенд не примет набор enum-ов — ступенчато упрощаем фильтр.
    const variants = onlySales ? [SALE_FEED_TYPES, ['Sale'], []] : [[]];
    let variant = 0;
    let body = this.feedFilters(filters, variants[variant]);
    let cursor: string | null = null;
    const seen = new Set<string>();
    let emptyPages = 0;

    while (true) {
      let data: { items?: unknown[]; cursor?: string | null };
      try {
        data = await this.call<{ items?: unknown[]; cursor?: string | null }>('/feed', {
          count: pageSize,
          cursor,
          ...body,
        });
      } catch (error) {
        const message = String((error as Error).message);
        if (message.includes('400') && variant + 1 < variants.length) {
          variant += 1;
          body = this.feedFilters(filters, variants[variant]);
          continue;
        }
        throw error;
      }

      const items = data?.items ?? [];
      if (!items.length) return;
      const page: TradeEvent[] = [];
      for (const raw of items as Array<Record<string, any>>) {
        const event = this.toEvent(raw);
        if (!event) continue;
        const key = String(raw.id ?? `${event.ts.toISOString()}-${event.priceTon}-${event.number}`);
        if (seen.has(key)) continue;
        seen.add(key);
        if (onlySales && event.kind !== 'sale') continue;
        if (!matches(filters, event)) continue;
        page.push(event);
      }
      if (page.length) {
        emptyPages = 0;
        yield page;
      } else if ((emptyPages += 1) >= 3) {
        emptyPages = 0;
        yield [];
      }
      cursor = data?.cursor ?? null;
      if (!cursor) return;
      await sleep(100);
    }
  }

  // ---------------------------------------------------------------- витрина
  async listings(filters: Filters, limit = 30): Promise<TradeEvent[]> {
    const body = {
      count: 20,
      cursor: '',
      collectionNames: filters.collection ? [filters.collection] : [],
      modelNames: filters.model ? [filters.model] : [],
      backdropNames: filters.backdrop ? [filters.backdrop] : [],
      symbolNames: filters.symbol ? [filters.symbol] : [],
      minPrice: filters.minPrice ? Math.round(filters.minPrice * NANO) : null,
      maxPrice: filters.maxPrice ? Math.round(filters.maxPrice * NANO) : null,
      number: filters.number ?? null,
      isPremarket: null,
      isNew: null,
      luckyBuy: null,
      giftType: 'Upgraded',
      craftable: null,
      isCrafted: null,
      tgCanBeCraftedFrom: null,
      removeSelfSales: null,
      isTransferable: null,
      availableForStaking: null,
      forGame: null,
      ordering: 'Price',
      lowToHigh: true,
      query: null,
    };
    // Витрина отсортирована по возрастанию цены, поэтому за один запрос видно
    // только 20 самых дешёвых лотов. Для поиска «в диапазоне 70-90» этого мало —
    // идём по курсору, пока не наберём нужное количество.
    const lots: TradeEvent[] = [];
    let cursor = '';
    for (let page = 0; page < 6 && lots.length < limit; page += 1) {
      const data = await this.call<{ gifts?: Array<Record<string, any>>; cursor?: string | null }>(
        '/gifts/saling',
        { ...body, cursor },
      );
      const gifts = data?.gifts ?? [];
      if (!gifts.length) break;
      for (const gift of gifts) {
        const event = this.giftToEvent(gift);
        if (event && matches(filters, event)) lots.push(event);
      }
      cursor = data?.cursor ?? '';
      if (!cursor) break;
      await sleep(80);
    }
    return lots.sort((a, b) => a.priceTon - b.priceTon).slice(0, limit);
  }

  // ------------------------------------------------------------ нормализация
  private toEvent(item: Record<string, any>): TradeEvent | null {
    const gift = item?.gift;
    if (!gift) return null;
    const rawKind = String(item.type ?? '').toLowerCase();
    const amount = toNumber(item.amount);
    const priceTon = amount ? amount / NANO : toNumber(gift.salePrice) / NANO;
    return {
      market: this.title,
      kind: KIND_MAP[rawKind] ?? rawKind ?? 'unknown',
      collection: String(gift.collectionName ?? gift.title ?? ''),
      model: gift.modelName ?? gift.modelTitle ?? null,
      backdrop: gift.backdropName ?? null,
      symbol: gift.symbolName ?? null,
      number: gift.number ?? null,
      priceTon: round(priceTon),
      ts: parseTs(item.date),
      giftName: gift.name ?? null,
      externalId: item.id ? String(item.id) : null,
    };
  }

  private giftToEvent(gift: Record<string, any>): TradeEvent | null {
    if (!gift) return null;
    return {
      market: this.title,
      kind: 'active_listing',
      collection: String(gift.collectionName ?? gift.title ?? ''),
      model: gift.modelName ?? gift.modelTitle ?? null,
      backdrop: gift.backdropName ?? null,
      symbol: gift.symbolName ?? null,
      number: gift.number ?? null,
      priceTon: round(toNumber(gift.salePrice) / NANO),
      ts: parseTs(gift.exportDate),
      giftName: gift.name ?? null,
      externalId: gift.id ? String(gift.id) : null,
    };
  }
}

export function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Доп. проверка на клиенте: часть фильтров площадки не поддерживают. */
export function matches(filters: Filters, event: TradeEvent): boolean {
  if (!sameAttr(filters.collection, event.collection)) return false;
  if (!sameAttr(filters.model, event.model)) return false;
  if (!sameAttr(filters.backdrop, event.backdrop)) return false;
  if (!sameAttr(filters.symbol, event.symbol)) return false;
  if (filters.number != null && event.number !== filters.number) return false;
  if (!inPriceRange(filters, event.priceTon)) return false;
  return true;
}

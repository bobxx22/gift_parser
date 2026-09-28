/**
 * Официальный маркет Telegram (перепродажа подарков внутри мессенджера).
 *
 *   payments.getStarGifts               -> каталог, title -> giftId
 *   payments.getResaleStarGifts         -> активные лоты: цена в Stars и в TON
 *   payments.getUniqueStarGiftValueInfo -> оценка Telegram (флор, средняя, последняя)
 *
 * Истории сделок официальный API не отдаёт — только лоты и оценку.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Api } from 'teleproto';

import {
  BackdropColors,
  Filters,
  MarketClient,
  MarketKey,
  OfficialValue,
  TradeEvent,
} from '../common/types';
import { normalizeAttr } from '../common/utils';
import { TelegramService } from '../telegram/telegram.service';
import { MarketError } from './http';
import { RateLimiterService } from './rate-limiter';
import { round } from './mrkt.service';

const NANO = 1_000_000_000;

interface ResaleResult {
  count: number;
  gifts: any[];
  nextOffset?: string;
  attributes?: any[];
}

@Injectable()
export class TelegramMarketService implements MarketClient {
  readonly key: MarketKey = 'telegram';
  readonly title = 'Telegram';
  readonly providesHistory = false;
  readonly providesListings = true;
  readonly needsLogin = true;
  readonly note = 'официальный маркет: лоты и оценка Telegram, истории сделок нет';

  private readonly logger = new Logger(TelegramMarketService.name);
  private catalogCache: Map<string, any> | null = null;
  private attributeCache = new Map<string, any[]>();
  private valueCache = new Map<string, { ts: number; value: OfficialValue }>();

  constructor(
    private readonly telegram: TelegramService,
    private readonly limiter: RateLimiterService,
  ) {}

  /** Все вызовы MTProto идут через общий ограничитель. */
  private invoke<T>(request: Parameters<TelegramService['invoke']>[0]): Promise<T> {
    return this.limiter.run(this.key, () => this.telegram.invoke<T>(request));
  }

  // --------------------------------------------------------------- каталог
  async catalog(refresh = false): Promise<Map<string, any>> {
    if (this.catalogCache && !refresh) return this.catalogCache;
    const result = await this.invoke<{ gifts: any[] }>(
      new Api.payments.GetStarGifts({ hash: 0 }),
    );
    const catalog = new Map<string, any>();
    for (const gift of result.gifts ?? []) {
      if (gift.title) catalog.set(String(gift.title), gift.id);
    }
    this.catalogCache = catalog;
    return catalog;
  }

  async giftId(collection: string): Promise<any | null> {
    const catalog = await this.catalog();
    if (catalog.has(collection)) return catalog.get(collection);
    const target = normalizeAttr(collection);
    for (const [title, id] of catalog) {
      if (normalizeAttr(title) === target) return id;
    }
    return null;
  }

  /** Полный список атрибутов подарка: модели, символы и фоны с их цветами. */
  async attributes(giftId: any): Promise<any[]> {
    const key = String(giftId);
    const cached = this.attributeCache.get(key);
    if (cached) return cached;
    const result = await this.invoke<ResaleResult>(
      new Api.payments.GetResaleStarGifts({
        giftId,
        offset: '',
        limit: 1,
        sortByPrice: true,
        attributesHash: 0 as never,
      }),
    );
    const attributes = result.attributes ?? [];
    this.attributeCache.set(key, attributes);
    return attributes;
  }

  /** Цвета фонов из Telegram — ими рисуется карточка подарка. */
  async backdropColors(collection: string): Promise<Record<string, BackdropColors>> {
    const giftId = await this.giftId(collection);
    if (!giftId) return {};
    const out: Record<string, BackdropColors> = {};
    for (const attribute of await this.attributes(giftId)) {
      if (attribute.className !== 'StarGiftAttributeBackdrop') continue;
      out[String(attribute.name)] = {
        center: Number(attribute.centerColor),
        edge: Number(attribute.edgeColor),
        pattern: Number(attribute.patternColor),
        text: Number(attribute.textColor),
      };
    }
    return out;
  }

  private async attributeIds(giftId: any, filters: Filters): Promise<any[]> {
    const wanted: Record<string, string | null | undefined> = {
      StarGiftAttributeModel: filters.model,
      StarGiftAttributePattern: filters.symbol,
      StarGiftAttributeBackdrop: filters.backdrop,
    };
    if (!Object.values(wanted).some(Boolean)) return [];
    const ids: any[] = [];
    for (const attribute of await this.attributes(giftId)) {
      const target = wanted[attribute.className];
      if (!target || normalizeAttr(attribute.name) !== normalizeAttr(target)) continue;
      if (attribute.className === 'StarGiftAttributeModel') {
        ids.push(new Api.StarGiftAttributeIdModel({ documentId: attribute.document.id }));
      } else if (attribute.className === 'StarGiftAttributePattern') {
        ids.push(new Api.StarGiftAttributeIdPattern({ documentId: attribute.document.id }));
      } else {
        ids.push(new Api.StarGiftAttributeIdBackdrop({ backdropId: attribute.backdropId }));
      }
    }
    return ids;
  }

  // ------------------------------------------------------------------ лоты
  async listings(filters: Filters, limit = 30): Promise<TradeEvent[]> {
    const giftId = await this.giftId(filters.collection);
    if (!giftId) throw new MarketError(`Telegram: подарок «${filters.collection}» не найден в каталоге`);
    const attributes = await this.attributeIds(giftId, filters);
    const collected: any[] = [];
    let offset = '';
    while (collected.length < limit) {
      const result = await this.invoke<ResaleResult>(
        new Api.payments.GetResaleStarGifts({
          giftId,
          offset,
          limit: Math.min(50, limit - collected.length),
          sortByPrice: true,
          ...(attributes.length ? { attributes } : {}),
        }),
      );
      const gifts = result.gifts ?? [];
      collected.push(...gifts);
      offset = result.nextOffset ?? '';
      if (!offset || !gifts.length) break;
    }
    return collected
      .map((gift) => this.toEvent(gift, filters))
      .filter((event): event is TradeEvent => Boolean(event && event.priceTon > 0))
      .slice(0, limit);
  }

  // eslint-disable-next-line require-yield
  async *historyPages(): AsyncGenerator<TradeEvent[]> {
    // Официальный API истории сделок не отдаёт.
    return;
  }

  /** Конкретный экземпляр по slug (HeroicHelmet-1349) — атрибуты и цвета фона. */
  async uniqueGift(slug: string): Promise<{
    slug: string;
    number: number | null;
    collection: string;
    model: string | null;
    backdrop: string | null;
    symbol: string | null;
    colors: BackdropColors | null;
  } | null> {
    if (!slug) return null;
    const result = await this.invoke<{ gift: any }>(
      new Api.payments.GetUniqueStarGift({ slug }),
    );
    const gift = result?.gift;
    if (!gift) return null;
    let model: string | null = null;
    let symbol: string | null = null;
    let backdrop: string | null = null;
    let colors: BackdropColors | null = null;
    for (const attribute of gift.attributes ?? []) {
      if (attribute.className === 'StarGiftAttributeModel') model = attribute.name;
      else if (attribute.className === 'StarGiftAttributePattern') symbol = attribute.name;
      else if (attribute.className === 'StarGiftAttributeBackdrop') {
        backdrop = attribute.name;
        colors = {
          center: Number(attribute.centerColor),
          edge: Number(attribute.edgeColor),
          pattern: Number(attribute.patternColor),
          text: Number(attribute.textColor),
        };
      }
    }
    return {
      slug: String(gift.slug ?? slug),
      number: gift.num ?? null,
      collection: String(gift.title ?? ''),
      model,
      backdrop,
      symbol,
      colors,
    };
  }

  // ---------------------------------------------------------------- оценка
  async valueInfo(slug: string, ttlMs = 300_000): Promise<OfficialValue | null> {
    if (!slug) return null;
    const cached = this.valueCache.get(slug);
    if (cached && Date.now() - cached.ts < ttlMs) return cached.value;
    try {
      const result = await this.invoke<any>(
        new Api.payments.GetUniqueStarGiftValueInfo({ slug }),
      );
      const money = (value: unknown): number | null =>
        value === null || value === undefined ? null : Number(value) / 100;
      const info: OfficialValue = {
        currency: String(result.currency ?? ''),
        value: money(result.value),
        floor: money(result.floorPrice),
        average: money(result.averagePrice),
        lastSale: money(result.lastSalePrice),
        lastSaleDate: result.lastSaleDate ? new Date(Number(result.lastSaleDate) * 1000).toISOString() : null,
        listedCount: result.listedCount ?? null,
        fragmentListedCount: result.fragmentListedCount ?? null,
      };
      this.valueCache.set(slug, { ts: Date.now(), value: info });
      return info;
    } catch (error) {
      this.logger.warn(`Оценка Telegram для ${slug}: ${String(error)}`);
      return null;
    }
  }

  // ------------------------------------------------------------ нормализация
  private toEvent(gift: any, filters: Filters): TradeEvent | null {
    const attributes: Record<string, string> = {};
    for (const attribute of gift.attributes ?? []) {
      if (attribute.className === 'StarGiftAttributeModel') attributes.model = attribute.name;
      else if (attribute.className === 'StarGiftAttributePattern') attributes.symbol = attribute.name;
      else if (attribute.className === 'StarGiftAttributeBackdrop') attributes.backdrop = attribute.name;
    }
    let priceTon = 0;
    let stars: number | null = null;
    for (const amount of gift.resellAmount ?? []) {
      if (amount.className === 'StarsTonAmount') priceTon = Number(amount.amount) / NANO;
      else if (amount.className === 'StarsAmount') stars = Number(amount.amount);
    }
    return {
      market: this.title,
      kind: 'active_listing',
      collection: String(gift.title ?? filters.collection),
      model: attributes.model ?? null,
      backdrop: attributes.backdrop ?? null,
      symbol: attributes.symbol ?? null,
      number: gift.num ?? null,
      priceTon: round(priceTon),
      ts: new Date(),
      giftName: gift.slug ?? null,
      externalId: gift.slug ?? null,
      raw: { stars },
    };
  }
}

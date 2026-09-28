/**
 * Fragment — fragment.com (без авторизации, парсим отрендеренный HTML).
 *
 *   /gifts/<slug>?filter=sold&sort=listed    -> проданные по дате (история)
 *   /gifts/<slug>?filter=sale&sort=price_asc -> активные лоты (флор)
 *   &query=<текст>                            -> фильтр по одному атрибуту
 */

import { Injectable } from '@nestjs/common';
import { AxiosInstance } from 'axios';

import { Filters, HistoryOptions, MarketClient, MarketKey, TradeEvent } from '../common/types';
import { pascalName, parseTs, slugify, toNumber } from '../common/utils';
import { DESKTOP_USER_AGENT, MarketError, createHttp, requestWithRetry } from './http';
import { RateLimiterService } from './rate-limiter';
import { round } from './mrkt.service';

const ITEM_RE = /<a href="\/gift\/([^"?]+)[^"]*" class="tm-grid-item">([\s\S]{0,1500}?)<\/a>/g;
const PRICE_RE = /tm-grid-item-value tm-value[^>]*>([^<]*)</;
const STATUS_RE = /tm-grid-item-status[^>]*>([^<]*)</;
const TIME_RE = /datetime="([^"]+)"/;
const NUM_RE = /-(\d+)$/;

@Injectable()
export class FragmentService implements MarketClient {
  readonly key: MarketKey = 'fragment';
  readonly title = 'Fragment';
  readonly providesHistory = true;
  readonly providesListings = true;
  readonly needsLogin = false;
  readonly note = 'история до 60 сделок, фильтр по одному атрибуту';

  private readonly http: AxiosInstance;

  constructor(private readonly limiter: RateLimiterService) {
    this.http = createHttp('https://fragment.com', {
      'User-Agent': DESKTOP_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Content-Type': 'text/html; charset=utf-8',
    });
  }

  /** query у Fragment — один поисковый запрос, «модель И фон» он не умеет. */
  unsupportedReason(filters: Filters): string | null {
    const chosen = [filters.model, filters.backdrop, filters.symbol].filter(Boolean);
    return chosen.length > 1 ? 'Fragment ищет только по одному атрибуту — уточни что-то одно' : null;
  }

  private async fetch(filters: Filters, sold: boolean): Promise<string> {
    const short = slugify(filters.collection);
    const params: Record<string, string> = {
      filter: sold ? 'sold' : 'sale',
      sort: sold ? 'listed' : 'price_asc',
    };
    const query = [filters.model, filters.backdrop, filters.symbol].filter(Boolean).join(' ');
    if (query) params.query = query;
    const { status, data } = await this.limiter.run(this.key, () =>
      requestWithRetry<string>(
        this.http,
        { method: 'GET', url: `/gifts/${short}`, params, responseType: 'text' },
        `Fragment /gifts/${short}`,
      ),
    );
    if (status !== 200) throw new MarketError(`Fragment /gifts/${short} -> ${status}`, status);
    return String(data ?? '');
  }

  private parse(html: string, filters: Filters, kind: 'sale' | 'active_listing'): TradeEvent[] {
    const events: TradeEvent[] = [];
    const wanted = kind === 'sale' ? 'sold' : 'for sale';
    ITEM_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ITEM_RE.exec(html)) !== null) {
      const slug = match[1];
      const body = match[2];
      const status = (STATUS_RE.exec(body)?.[1] ?? '').trim().toLowerCase();
      if (status !== wanted) continue;
      const priceTon = toNumber((PRICE_RE.exec(body)?.[1] ?? '').replace(/,/g, ''));
      if (priceTon <= 0) continue;
      const num = NUM_RE.exec(slug)?.[1];
      events.push({
        market: this.title,
        kind,
        collection: filters.collection,
        // Fragment не показывает атрибуты в списке, но список уже отфильтрован
        // запросом — подставляем то, что искали.
        model: filters.model ?? null,
        backdrop: filters.backdrop ?? null,
        symbol: filters.symbol ?? null,
        number: num ? Number(num) : null,
        priceTon: round(priceTon),
        ts: parseTs(TIME_RE.exec(body)?.[1]),
        giftName: num ? `${pascalName(filters.collection)}-${num}` : slug,
        externalId: `${slug}-${TIME_RE.exec(body)?.[1] ?? ''}`,
      });
    }
    return events;
  }

  async *historyPages(filters: Filters, options: HistoryOptions = {}): AsyncGenerator<TradeEvent[]> {
    const pageSize = options.pageSize ?? 20;
    const html = await this.fetch(filters, true);
    const events = this.parse(html, filters, 'sale').sort((a, b) => b.ts.getTime() - a.ts.getTime());
    for (let index = 0; index < events.length; index += pageSize) {
      yield events.slice(index, index + pageSize);
    }
  }

  /**
   * Атрибуты конкретного экземпляра со страницы /gift/<slug> — запасной путь,
   * когда нет входа в Telegram. Значения лежат в ссылках вида
   * `/gifts/heroichelmet?attr%5BModel%5D=%5B%22Bengal%20Tiger%22%5D`.
   */
  async giftAttributes(slug: string): Promise<{
    model: string | null;
    backdrop: string | null;
    symbol: string | null;
  } | null> {
    const { status, data } = await this.limiter.run(this.key, () =>
      requestWithRetry<string>(
        this.http,
        { method: 'GET', url: `/gift/${slug.toLowerCase()}`, responseType: 'text' },
        `Fragment /gift/${slug}`,
      ),
    );
    if (status !== 200) return null;
    const html = String(data ?? '');
    const out: { model: string | null; backdrop: string | null; symbol: string | null } = {
      model: null,
      backdrop: null,
      symbol: null,
    };
    const pattern = /attr(?:%5B|\[)(Model|Backdrop|Symbol)(?:%5D|\])=([^"&]+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const kind = match[1].toLowerCase() as 'model' | 'backdrop' | 'symbol';
      if (out[kind]) continue;
      try {
        const decoded = decodeURIComponent(match[2]);
        const value = decoded.startsWith('[') ? (JSON.parse(decoded)[0] as string) : decoded;
        out[kind] = String(value).trim() || null;
      } catch {
        // значение в неожиданном виде — пропускаем
      }
    }
    return out.model || out.backdrop || out.symbol ? out : null;
  }

  async listings(filters: Filters, limit = 30): Promise<TradeEvent[]> {
    const html = await this.fetch(filters, false);
    return this.parse(html, filters, 'active_listing')
      .sort((a, b) => a.priceTon - b.priceTon)
      .slice(0, limit);
  }
}

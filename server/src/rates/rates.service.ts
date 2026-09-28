/**
 * Курс TON/USD по дням и пересчёт в USDT и Telegram Stars.
 *
 * Источники: Binance (длинная история дневных свечей) + CoinGecko (свежие 365 дней,
 * у бесплатного ключа больше не отдаётся). Вместе закрывают два года.
 * Дни хранятся в Postgres (ton_rates) и в памяти; отсутствующий день догружается точечно.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { Repository } from 'typeorm';

import { dayKey, toNumber } from '../common/utils';
import { TonRateEntity } from '../database/entities';

/** Цены звёзд фиксированы: покупка для покупателя, продажа — выручка продавца. */
export const STAR_BUY_USD = 0.015;
export const STAR_SELL_USD = 0.0118;

const HISTORY_DAYS = 730;
const BINANCE = 'https://api.binance.com/api/v3';
const COINGECKO = 'https://api.coingecko.com/api/v3';

@Injectable()
export class RatesService implements OnModuleInit {
  private readonly logger = new Logger(RatesService.name);
  private prices = new Map<string, number>();
  private missing = new Set<string>();
  private spotPrice: number | null = null;
  private spotTs = 0;
  private source = '';
  private refreshing: Promise<number> | null = null;

  constructor(
    @InjectRepository(TonRateEntity)
    private readonly repo: Repository<TonRateEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.load();
    if (this.prices.size < 30) {
      this.refresh().catch((error) => this.logger.warn(`Курс TON: ${String(error)}`));
    }
  }

  private async load(): Promise<void> {
    const rows = await this.repo.find();
    this.prices = new Map(rows.map((row) => [row.day, Number(row.priceUsd)]));
    this.source = rows[0]?.source ?? '';
  }

  get size(): number {
    return this.prices.size;
  }

  get lastDay(): string | null {
    if (!this.prices.size) return null;
    return [...this.prices.keys()].sort().at(-1) ?? null;
  }

  summary() {
    const days = [...this.prices.keys()].sort();
    const values = [...this.prices.values()];
    return {
      source: this.source,
      days: days.length,
      from: days[0] ?? null,
      to: days.at(-1) ?? null,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      spot: this.spotPrice,
      starBuyUsd: STAR_BUY_USD,
      starSellUsd: STAR_SELL_USD,
    };
  }

  // ------------------------------------------------------------- загрузка
  private async binance(startMs?: number, limit = 1000): Promise<Map<string, number>> {
    const response = await axios.get(`${BINANCE}/klines`, {
      params: { symbol: 'TONUSDT', interval: '1d', limit, ...(startMs ? { startTime: startMs } : {}) },
      timeout: 20_000,
    });
    const out = new Map<string, number>();
    for (const row of response.data as unknown[][]) {
      out.set(dayKey(Number(row[0])), Number(row[4]));
    }
    return out;
  }

  private async coingecko(days = 365): Promise<Map<string, number>> {
    const response = await axios.get(`${COINGECKO}/coins/the-open-network/market_chart`, {
      params: { vs_currency: 'usd', days: Math.min(days, 365), interval: 'daily' },
      timeout: 25_000,
    });
    const out = new Map<string, number>();
    for (const [stamp, price] of (response.data?.prices ?? []) as Array<[number, number]>) {
      out.set(dayKey(stamp), Number(price));
    }
    return out;
  }

  private async coingeckoRange(from: Date, to: Date): Promise<Map<string, number>> {
    const response = await axios.get(`${COINGECKO}/coins/the-open-network/market_chart/range`, {
      params: { vs_currency: 'usd', from: Math.floor(from.getTime() / 1000), to: Math.floor(to.getTime() / 1000) },
      timeout: 25_000,
    });
    const out = new Map<string, number>();
    for (const [stamp, price] of (response.data?.prices ?? []) as Array<[number, number]>) {
      const key = dayKey(stamp);
      if (!out.has(key)) out.set(key, Number(price));
    }
    return out;
  }

  /** Догружает историю: при первом запуске — два года. */
  async refresh(force = false): Promise<number> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh(force).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(force: boolean): Promise<number> {
    const today = dayKey(new Date());
    if (!force && this.prices.size && this.lastDay === today) return 0;
    const before = this.prices.size;
    const used: string[] = [];
    const fresh = new Map<string, number>();

    const loaders: Array<[string, () => Promise<Map<string, number>>]> = [
      ['binance', () => this.binance(Date.now() - HISTORY_DAYS * 86_400_000)],
      ['coingecko', () => this.coingecko(365)],
    ];
    for (const [name, loader] of loaders) {
      try {
        const data = await loader();
        if (data.size) {
          for (const [day, price] of data) fresh.set(day, price);
          used.push(name);
        }
      } catch (error) {
        this.logger.warn(`Курс TON (${name}): ${String((error as Error).message)}`);
      }
    }
    if (!fresh.size && !this.prices.size) throw new Error('не удалось загрузить курс TON');

    this.source = used.join('+') || this.source;
    for (const [day, price] of fresh) this.prices.set(day, price);
    this.missing.clear();
    if (fresh.size) {
      const rows = [...fresh.entries()].map(([day, priceUsd]) => ({ day, priceUsd, source: this.source }));
      for (let index = 0; index < rows.length; index += 500) {
        await this.repo.upsert(rows.slice(index, index + 500), ['day']);
      }
    }
    return this.prices.size - before;
  }

  /** Точечно догружает день, которого нет в списке. */
  private async fetchDay(day: string): Promise<number | null> {
    if (this.missing.has(day)) return null;
    const start = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(start.getTime())) return null;
    const loaders = [
      () => this.binance(start.getTime(), 2),
      () => this.coingeckoRange(new Date(start.getTime() - 86_400_000), new Date(start.getTime() + 2 * 86_400_000)),
    ];
    for (const loader of loaders) {
      try {
        const data = await loader();
        if (data.size) {
          for (const [key, price] of data) this.prices.set(key, price);
          await this.repo.upsert(
            [...data.entries()].map(([key, priceUsd]) => ({ day: key, priceUsd, source: this.source || 'ondemand' })),
            ['day'],
          );
        }
        if (data.has(day)) return data.get(day)!;
      } catch {
        // пробуем следующий источник
      }
    }
    this.missing.add(day);
    return null;
  }

  async spot(ttlMs = 120_000): Promise<number | null> {
    if (this.spotPrice && Date.now() - this.spotTs < ttlMs) return this.spotPrice;
    try {
      const response = await axios.get(`${COINGECKO}/simple/price`, {
        params: { ids: 'the-open-network', vs_currencies: 'usd' },
        timeout: 15_000,
      });
      const price = toNumber(response.data?.['the-open-network']?.usd);
      if (price) {
        this.spotPrice = price;
        this.spotTs = Date.now();
        return price;
      }
    } catch {
      // ниже пробуем Binance
    }
    try {
      const response = await axios.get(`${BINANCE}/ticker/price`, {
        params: { symbol: 'TONUSDT' },
        timeout: 15_000,
      });
      const price = toNumber(response.data?.price);
      if (price) {
        this.spotPrice = price;
        this.spotTs = Date.now();
      }
    } catch {
      // оставляем прошлое значение
    }
    return this.spotPrice;
  }

  // ---------------------------------------------------------------- расчёт
  /** Курс на дату события. Быстрый режим (allowFetch=false) не ходит в сеть. */
  priceOn(moment?: Date | string | null, allowFetch = false): number | null {
    if (!this.prices.size) return this.spotPrice;
    if (!moment) return this.spotPrice ?? this.prices.get(this.lastDay ?? '') ?? null;
    const day = dayKey(moment);
    const exact = this.prices.get(day);
    if (exact !== undefined) return exact;
    if (day >= dayKey(new Date())) return this.spotPrice ?? this.prices.get(this.lastDay ?? '') ?? null;
    if (allowFetch && !this.missing.has(day)) {
      void this.fetchDay(day);
    }
    return this.nearest(day);
  }

  private nearest(day: string): number | null {
    const target = new Date(`${day}T00:00:00Z`).getTime();
    if (Number.isNaN(target)) return null;
    for (let shift = 1; shift <= 7; shift += 1) {
      for (const delta of [-shift, shift]) {
        const key = dayKey(target + delta * 86_400_000);
        const price = this.prices.get(key);
        if (price !== undefined) return price;
      }
    }
    const days = [...this.prices.keys()].sort();
    if (!days.length) return null;
    return this.prices.get(day < days[0] ? days[0] : days.at(-1)!) ?? null;
  }

  usd(ton: number, moment?: Date | string | null): number | null {
    const rate = this.priceOn(moment ?? null, true);
    if (!rate) return null;
    return Math.round(ton * rate * 100) / 100;
  }

  /** Сколько звёзд нужно купить (основное число) или выручит продавец. */
  stars(ton: number, moment?: Date | string | null, mode: 'buy' | 'sell' = 'buy'): number | null {
    const usd = this.usd(ton, moment);
    if (usd === null) return null;
    return Math.round(usd / (mode === 'buy' ? STAR_BUY_USD : STAR_SELL_USD));
  }
}

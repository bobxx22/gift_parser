/**
 * Фоновый сканер «выгодных» подарков. Работает в два хода.
 *
 * 1. По снимку флоров (FloorsService держит его свежим за полтора десятка
 *    запросов на весь рынок) одним SQL находим позиции, которые прямо сейчас
 *    продаются заметно ниже медианы своих продаж. Это главный источник ленты:
 *    полный проход по всем коллекциям, моделям и фонам занимает миллисекунды,
 *    и найденное можно купить.
 * 2. Обход истории по кругу остаётся, но у него теперь другая работа —
 *    накапливать сделки в `trades`, из которых и считаются те самые медианы.
 *    Его находки помечаются source='sale': это уже состоявшиеся покупки.
 *
 * Нагрузка размазана: одна коллекция за тик, площадки параллельно, но все
 * запросы идут через общий ограничитель — поэтому фоновый обход не мешает
 * обычному поиску и не упирается в 429.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Filters, MarketKey, TradeEvent } from '../common/types';
import { giftLink } from '../common/utils';
import { CollectionEntity, DealEntity, FloorEntity, TradeEntity } from '../database/entities';
import { EventsGateway } from '../gateway/events.gateway';
import { MarketsRegistry } from '../markets/markets.registry';
import { RateLimiterService } from '../markets/rate-limiter';
import { RatesService } from '../rates/rates.service';
import { FloorsService } from './floors.service';

export interface ScannerSettings {
  enabled: boolean;
  /** Насколько ниже медианы должна быть цена, в процентах. */
  minDiscount: number;
  /** Сколько последних сделок брать с площадки за один заход. */
  batchSize: number;
  /** Минимум сделок в выборке, чтобы медиане можно было верить. */
  minSamples: number;
  /** Пауза между коллекциями при обходе истории, мс. */
  intervalMs: number;
  /** Какие площадки обходить (пустой список = все). */
  markets: MarketKey[];
  /** Как часто обновлять снимок флоров, мс. */
  floorsIntervalMs: number;
}

export type DealSort = 'discount' | 'time';

export interface DealDto {
  id: string;
  market: string;
  collection: string;
  collectionShort: string;
  model: string | null;
  backdrop: string | null;
  symbol: string | null;
  number: number | null;
  priceTon: number;
  priceUsd: number | null;
  stars: number | null;
  medianTon: number;
  discountPct: number;
  samples: number;
  /** floor — позиция в продаже прямо сейчас, sale — состоявшаяся сделка. */
  source: string;
  /** По чему считали опору: collection, model или backdrop. */
  scope: string;
  ts: string;
  giftName: string | null;
  link: string | null;
  image: string | null;
}

const DEFAULTS: ScannerSettings = {
  enabled: true,
  minDiscount: 10,
  batchSize: 10,
  minSamples: 10,
  // Обход истории больше не ищет находки — он копит сделки для медиан,
  // поэтому идёт спокойно и не отбирает у поиска место в очереди запросов.
  intervalMs: 30_000,
  markets: [],
  floorsIntervalMs: 5 * 60_000,
};

interface FloorDealRow {
  market: string;
  collectionShort: string;
  collection: string;
  kind: string;
  value: string;
  floorTon: number;
  baselineTon: number;
  changedAt: string;
  median: number | null;
  samples: number | null;
}

const MEDIAN_WINDOW_DAYS = 30;
/**
 * Окно для страховочной медианы в поиске по флорам. Оно шире основного:
 * задача не посчитать точную цену, а понять порядок величины — не выдаём ли мы
 * за находку флор, который упал, но всё равно дороже, чем такие подарки уходят.
 */
const GUARD_WINDOW_DAYS = 90;
const GUARD_MIN_SAMPLES = 5;
/** Допуск к медиане: чуть выше неё ещё нормально, заметно выше — не находка. */
const GUARD_TOLERANCE = 1.1;
/** Скидка больше этой — почти наверняка не рыночная сделка, а артефакт. */
const MAX_DISCOUNT_PCT = 90;
const DEALS_TTL_HOURS = 48;

@Injectable()
export class ScannerService implements OnModuleInit {
  private readonly logger = new Logger(ScannerService.name);
  private settings: ScannerSettings = { ...DEFAULTS };
  private queue: CollectionEntity[] = [];
  private cursor = 0;
  private running = false;
  private scanningFloors = false;
  private lastCollection: string | null = null;
  private lastRunAt = 0;
  private scanned = 0;
  private found = 0;
  /** Медианы в пределах одного прохода, чтобы не долбить базу одинаковыми запросами. */
  private medianCache = new Map<string, { median: number; samples: number; ts: number }>();

  constructor(
    private readonly markets: MarketsRegistry,
    private readonly rates: RatesService,
    private readonly gateway: EventsGateway,
    private readonly limiter: RateLimiterService,
    private readonly floors: FloorsService,
    @InjectRepository(FloorEntity)
    private readonly floorsRepo: Repository<FloorEntity>,
    @InjectRepository(CollectionEntity)
    private readonly collectionsRepo: Repository<CollectionEntity>,
    @InjectRepository(TradeEntity)
    private readonly tradesRepo: Repository<TradeEntity>,
    @InjectRepository(DealEntity)
    private readonly dealsRepo: Repository<DealEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reloadQueue();
  }

  // ------------------------------------------------------------- настройки
  getSettings(): ScannerSettings {
    return { ...this.settings };
  }

  updateSettings(patch: Partial<ScannerSettings>): ScannerSettings {
    this.settings = {
      ...this.settings,
      ...patch,
      minDiscount: Math.min(90, Math.max(1, patch.minDiscount ?? this.settings.minDiscount)),
      batchSize: Math.min(50, Math.max(5, patch.batchSize ?? this.settings.batchSize)),
      minSamples: Math.min(50, Math.max(2, patch.minSamples ?? this.settings.minSamples)),
      intervalMs: Math.min(120_000, Math.max(2000, patch.intervalMs ?? this.settings.intervalMs)),
      markets: (patch.markets ?? this.settings.markets).filter((key) =>
        this.markets.keys().includes(key),
      ),
      floorsIntervalMs: Math.min(
        3600_000,
        Math.max(60_000, patch.floorsIntervalMs ?? this.settings.floorsIntervalMs),
      ),
    };
    this.floors.setInterval(this.settings.floorsIntervalMs);
    return this.getSettings();
  }

  async status() {
    return {
      ...this.settings,
      queueSize: this.queue.length,
      position: this.cursor,
      lastCollection: this.lastCollection,
      lastRunAt: this.lastRunAt ? new Date(this.lastRunAt).toISOString() : null,
      scannedCollections: this.scanned,
      dealsFound: this.found,
      running: this.running,
      floors: await this.floors.status(),
      limiter: this.limiter.stats(),
    };
  }

  private async reloadQueue(): Promise<void> {
    // Популярные коллекции первыми: по ним больше сделок и меньше шума в медиане.
    this.queue = await this.collectionsRepo.find({ order: { volume: 'DESC' } });
    this.cursor = 0;
  }

  // ------------------------------------------------------------------ цикл
  @Interval(2000)
  async tick(): Promise<void> {
    if (!this.settings.enabled || this.running) return;
    if (Date.now() - this.lastRunAt < this.settings.intervalMs) return;
    if (!this.queue.length) {
      await this.reloadQueue();
      if (!this.queue.length) return;
    }
    const collection = this.queue[this.cursor % this.queue.length];
    this.cursor = (this.cursor + 1) % this.queue.length;
    await this.scanCollection(collection).catch((error) =>
      this.logger.debug(`Скан ${collection.name}: ${String((error as Error).message)}`),
    );
  }

  /** Один проход по коллекции: свежие сделки со всех площадок параллельно. */
  async scanCollection(collection: CollectionEntity): Promise<DealDto[]> {
    this.running = true;
    this.lastRunAt = Date.now();
    this.lastCollection = collection.name;
    try {
      const filters: Filters = { collection: collection.name };
      const wanted = this.settings.markets.length ? this.settings.markets : this.markets.keys();
      const results = await Promise.allSettled(
        wanted.map(async (key: MarketKey) => {
          const client = this.markets.get(key);
          if (!client?.providesHistory) return [] as TradeEvent[];
          if (client.unsupportedReason?.(filters)) return [] as TradeEvent[];
          const pager = client.historyPages(filters, {
            onlySales: true,
            pageSize: this.settings.batchSize,
          });
          const page = await pager.next();
          await pager.return?.(undefined as never);
          return page.done ? [] : page.value ?? [];
        }),
      );
      const events = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
      if (!events.length) return [];

      const fresh = await this.persistTrades(collection, events);
      this.scanned += 1;
      const deals = await this.findDeals(collection, fresh);
      if (deals.length) {
        this.found += deals.length;
        this.gateway.emitDeals(deals);
      }
      return deals;
    } finally {
      this.running = false;
    }
  }

  /** Скан по названию коллекции — используется кнопкой «проверить сейчас». */
  async scanByName(name: string): Promise<DealDto[]> {
    const collection = await this.collectionsRepo.findOne({ where: { name } });
    if (!collection) return [];
    return this.scanCollection(collection);
  }

  // ----------------------------------------------------- выгодные по флорам
  /**
   * Главный цикл ленты: сравниваем текущий флор с его же скользящей средней.
   *
   * Почему не с медианой продаж: флор — это минимум предложения, медиана —
   * середина сделок, поэтому «флор ниже медианы» верно почти всегда и находкой
   * не является. А вот флор, упавший относительно собственной недавней
   * истории, — это ровно то, что нужно: кто-то только что выставил дёшево.
   * Медиану продаж используем как страховку: если по позиции есть история,
   * цена должна быть ниже неё, иначе это не выгодная покупка.
   */
  @Interval(20_000)
  async floorTick(): Promise<void> {
    if (!this.settings.enabled || this.scanningFloors) return;
    await this.scanFloors().catch((error) =>
      this.logger.debug(`Скан флоров: ${String((error as Error).message)}`),
    );
  }

  async scanFloors(): Promise<DealDto[]> {
    this.scanningFloors = true;
    try {
      const titles = this.settings.markets.length
        ? this.settings.markets.map((key) => this.markets.get(key)?.title ?? key)
        : null;

      const rows: FloorDealRow[] = await this.floorsRepo.query(
        `
        with med as (
          select "collectionShort" as short, 'collection' as kind, '' as value,
                 percentile_cont(0.5) within group (order by "priceTon") as median,
                 count(*)::int as samples
            from trades
           where kind = 'sale' and "priceTon" > 0 and ts > now() - interval '${GUARD_WINDOW_DAYS} days'
           group by 1
          union all
          select "collectionShort", 'model', model,
                 percentile_cont(0.5) within group (order by "priceTon"), count(*)::int
            from trades
           where kind = 'sale' and "priceTon" > 0 and ts > now() - interval '${GUARD_WINDOW_DAYS} days'
             and model is not null
           group by 1, 3
          union all
          select "collectionShort", 'backdrop', backdrop,
                 percentile_cont(0.5) within group (order by "priceTon"), count(*)::int
            from trades
           where kind = 'sale' and "priceTon" > 0 and ts > now() - interval '${GUARD_WINDOW_DAYS} days'
             and backdrop is not null
           group by 1, 3
        )
        select f.market, f."collectionShort", f.collection, f.kind, f.value,
               f."floorTon", f."baselineTon", f."changedAt",
               m.median::double precision as median, coalesce(m.samples, 0) as samples
          from floors f
          left join med m
                 on m.short = f."collectionShort" and m.kind = f.kind and m.value = f.value
         where f."floorTon" > 0
           and f."baselineTon" is not null
           and f."changedAt" > now() - interval '24 hours'
           and (f."baselineTon" - f."floorTon") / f."baselineTon" * 100 between $1 and $2
           and (m.samples is null or m.samples < $3 or f."floorTon" <= m.median * ${GUARD_TOLERANCE})
           ${titles ? 'and f.market = any($4)' : ''}
         order by (f."baselineTon" - f."floorTon") / f."baselineTon" desc
         limit 200
        `,
        titles
          ? [this.settings.minDiscount, MAX_DISCOUNT_PCT, GUARD_MIN_SAMPLES, titles]
          : [this.settings.minDiscount, MAX_DISCOUNT_PCT, GUARD_MIN_SAMPLES],
      );

      const deals = rows.map((row) => {
        const discount = ((row.baselineTon - row.floorTon) / row.baselineTon) * 100;
        return this.dealsRepo.create({
          market: row.market,
          collectionShort: row.collectionShort,
          collection: row.collection,
          model: row.kind === 'model' ? row.value : null,
          backdrop: row.kind === 'backdrop' ? row.value : null,
          symbol: null,
          number: null,
          priceTon: row.floorTon,
          medianTon: Math.round(row.baselineTon * 100) / 100,
          discountPct: Math.round(discount * 10) / 10,
          samples: Number(row.samples ?? 0),
          source: 'floor',
          scope: row.kind,
          ts: new Date(row.changedAt),
          giftName: null,
          // Один и тот же флор не должен падать в ленту на каждом снимке.
          dedupKey: `floor|${row.collectionShort}|${row.kind}|${row.value}|${row.floorTon}`.slice(0, 128),
        });
      });
      if (!deals.length) return [];

      const result = await this.dealsRepo
        .createQueryBuilder()
        .insert()
        .into(DealEntity)
        .values(deals)
        .orIgnore()
        .returning(['market', 'dedupKey'])
        .execute();
      const inserted = new Set(
        (result.raw as Array<{ market: string; dedupKey: string }>).map(
          (row) => `${row.market}:${row.dedupKey}`,
        ),
      );
      const fresh = deals.filter((deal) => inserted.has(`${deal.market}:${deal.dedupKey}`));
      if (fresh.length) {
        this.found += fresh.length;
        const dtos = fresh.map((deal) => this.toDto(deal));
        this.gateway.emitDeals(dtos);
        return dtos;
      }
      return [];
    } finally {
      this.scanningFloors = false;
    }
  }

  // ------------------------------------------------------------------ база
  /** Пишем сделки и возвращаем только те, которых раньше не было. */
  private async persistTrades(collection: CollectionEntity, events: TradeEvent[]): Promise<TradeEvent[]> {
    const rows = events.map((event) => ({
      market: event.market,
      kind: event.kind,
      collectionShort: collection.shortName,
      collection: event.collection || collection.name,
      model: event.model ?? null,
      backdrop: event.backdrop ?? null,
      symbol: event.symbol ?? null,
      number: event.number ?? null,
      priceTon: event.priceTon,
      ts: event.ts,
      giftName: event.giftName ?? null,
      oldPrice: event.oldPrice ?? null,
      dedupKey: this.dedupKey(event),
    }));
    if (!rows.length) return [];
    const result = await this.tradesRepo
      .createQueryBuilder()
      .insert()
      .into(TradeEntity)
      .values(rows)
      .orIgnore()
      .returning(['market', 'dedupKey'])
      .execute();
    const inserted = new Set(
      (result.raw as Array<{ market: string; dedupKey: string }>).map(
        (row) => `${row.market}:${row.dedupKey}`,
      ),
    );
    return events.filter((event) => inserted.has(`${event.market}:${this.dedupKey(event)}`));
  }

  private dedupKey(event: TradeEvent): string {
    return (
      event.externalId ??
      `${event.ts.toISOString()}|${event.number ?? ''}|${event.priceTon}|${event.kind}`
    ).slice(0, 128);
  }

  /** Медиана по связке коллекция+модель за последние 30 дней. */
  private async medianFor(
    collectionShort: string,
    model: string | null,
  ): Promise<{ median: number; samples: number }> {
    const key = `${collectionShort}|${model ?? ''}`;
    const cached = this.medianCache.get(key);
    if (cached && Date.now() - cached.ts < 5 * 60_000) return cached;

    const query = this.tradesRepo
      .createQueryBuilder('trade')
      .select('percentile_cont(0.5) within group (order by trade.priceTon)', 'median')
      .addSelect('count(*)', 'samples')
      .where('trade.collectionShort = :collectionShort', { collectionShort })
      .andWhere('trade.kind = :kind', { kind: 'sale' })
      .andWhere("trade.ts > now() - interval '30 days'");
    if (model) query.andWhere('trade.model = :model', { model });

    const row = await query.getRawOne<{ median: string | null; samples: string }>();
    const value = {
      median: Number(row?.median ?? 0),
      samples: Number(row?.samples ?? 0),
      ts: Date.now(),
    };
    this.medianCache.set(key, value);
    return value;
  }

  /**
   * Опорная медиана: сначала по модели, но если сделок по ней мало —
   * берём медиану всей коллекции. Иначе «скидка» считается от случайных пяти
   * сделок и получается мусор.
   */
  private async median(
    collectionShort: string,
    model: string | null,
  ): Promise<{ median: number; samples: number }> {
    if (model) {
      const byModel = await this.medianFor(collectionShort, model);
      if (byModel.samples >= this.settings.minSamples) return byModel;
    }
    return this.medianFor(collectionShort, null);
  }

  private async findDeals(collection: CollectionEntity, events: TradeEvent[]): Promise<DealDto[]> {
    const deals: DealEntity[] = [];
    for (const event of events) {
      if (event.kind !== 'sale' || event.priceTon <= 0) continue;
      const { median, samples } = await this.median(collection.shortName, event.model ?? null);
      if (!median || samples < this.settings.minSamples) continue;
      const discount = ((median - event.priceTon) / median) * 100;
      if (discount < this.settings.minDiscount || discount > MAX_DISCOUNT_PCT) continue;
      deals.push(
        this.dealsRepo.create({
          market: event.market,
          collectionShort: collection.shortName,
          collection: event.collection || collection.name,
          model: event.model ?? null,
          backdrop: event.backdrop ?? null,
          symbol: event.symbol ?? null,
          number: event.number ?? null,
          priceTon: event.priceTon,
          medianTon: Math.round(median * 100) / 100,
          discountPct: Math.round(discount * 10) / 10,
          samples,
          source: 'sale',
          scope: event.model ? 'model' : 'collection',
          ts: event.ts,
          giftName: event.giftName ?? null,
          dedupKey: this.dedupKey(event),
        }),
      );
    }
    if (!deals.length) return [];
    await this.dealsRepo
      .createQueryBuilder()
      .insert()
      .into(DealEntity)
      .values(deals)
      .orIgnore()
      .execute();
    return deals.map((deal) => this.toDto(deal));
  }

  // ------------------------------------------------------------------ лента
  async list(
    options: {
      minDiscount?: number;
      hours?: number;
      limit?: number;
      markets?: string[];
      sort?: DealSort;
      minPrice?: number;
      maxPrice?: number;
    } = {},
  ): Promise<DealDto[]> {
    const minDiscount = options.minDiscount ?? this.settings.minDiscount;
    const hours = options.hours ?? 24;
    const query = this.dealsRepo
      .createQueryBuilder('deal')
      .where('deal.discountPct >= :minDiscount', { minDiscount })
      .andWhere(`deal.ts > now() - interval '${Math.max(1, Math.min(720, hours))} hours'`);

    // В ленте площадки хранятся названиями (MRKT, Portals) — принимаем и ключи.
    const titles = (options.markets ?? [])
      .map((value) => this.markets.get(value as MarketKey)?.title ?? value)
      .filter(Boolean);
    if (titles.length) query.andWhere('deal.market IN (:...titles)', { titles });

    // Ценовой диапазон: «ищу подарок на 70-90 TON» — лишнее не показываем.
    if (options.minPrice) query.andWhere('deal.priceTon >= :minPrice', { minPrice: options.minPrice });
    if (options.maxPrice) query.andWhere('deal.priceTon <= :maxPrice', { maxPrice: options.maxPrice });

    if (options.sort === 'discount') {
      query.orderBy('deal.discountPct', 'DESC').addOrderBy('deal.ts', 'DESC');
    } else {
      query.orderBy('deal.ts', 'DESC');
    }

    const rows = await query.limit(Math.min(200, options.limit ?? 60)).getMany();
    return rows.map((row) => this.toDto(row));
  }

  private toDto(deal: DealEntity): DealDto {
    const ts = deal.ts instanceof Date ? deal.ts : new Date(deal.ts);
    return {
      id: deal.id ?? `${deal.market}:${deal.dedupKey}`,
      market: deal.market,
      collection: deal.collection,
      collectionShort: deal.collectionShort,
      model: deal.model,
      backdrop: deal.backdrop,
      symbol: deal.symbol,
      number: deal.number,
      priceTon: deal.priceTon,
      priceUsd: this.rates.usd(deal.priceTon, ts),
      stars: this.rates.stars(deal.priceTon, ts),
      medianTon: deal.medianTon,
      discountPct: deal.discountPct,
      samples: deal.samples,
      source: deal.source ?? 'sale',
      scope: deal.scope ?? 'model',
      ts: ts.toISOString(),
      giftName: deal.giftName,
      link: giftLink(deal.giftName, deal.collection, deal.number),
      image: deal.model
        ? `/images/${deal.collectionShort}/${encodeURIComponent(deal.model)}.png`
        : null,
    };
  }

  /** Раз в час чистим ленту от старых находок. */
  @Interval(3_600_000)
  async cleanup(): Promise<void> {
    await this.dealsRepo
      .createQueryBuilder()
      .delete()
      .where(`ts < now() - interval '${DEALS_TTL_HOURS} hours'`)
      .execute()
      .catch(() => undefined);
    this.medianCache.clear();
    await this.reloadQueue();
  }
}

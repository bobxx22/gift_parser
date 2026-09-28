/**
 * Поиск по всем площадкам сразу.
 *
 * Главный принцип — ничего не ждём последовательно: площадки опрашиваются
 * параллельно, и каждая порция сделок уходит во фронт по WebSocket сразу,
 * как только пришла. Свежие сделки в приоритете: у всех площадок берётся
 * первая (самая новая) страница, и только по мере прокрутки — следующие.
 *
 *   1. при создании сессии сразу отдаём то, что уже накоплено в Postgres;
 *   2. параллельно тянем лоты (флоры) и первую страницу истории с каждой площадки;
 *   3. каждая пришедшая пачка тут же летит в график и таблицу;
 *   4. при прокрутке добираем следующую страницу — тоже параллельно;
 *   5. раз в 20 секунд подтягиваем новые сделки, раз в минуту — флоры.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';

import {
  FloorInfo,
  Filters,
  MarketKey,
  OfficialValue,
  SearchQuery,
  Stats,
  TradeDto,
  TradeEvent,
  inPriceRange,
} from '../common/types';
import { giftLink, slugify } from '../common/utils';
import { ListingEntity, TradeEntity } from '../database/entities';
import { CatalogService } from '../catalog/catalog.service';
import { MarketsRegistry } from '../markets/markets.registry';
import { TelegramMarketService } from '../markets/telegram-market.service';
import { RatesService } from '../rates/rates.service';
import { EventsGateway } from '../gateway/events.gateway';
import { computeStats, emptyStats } from './stats';

const DEFAULT_SOURCES: MarketKey[] = ['mrkt', 'portals', 'fragment', 'telegram', 'tonnel'];

/** Пустое поле, ноль и мусор из формы считаем «границы нет». */
function positive(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
/** Первая страница маленькая — чтобы данные появились на экране за секунду-две. */
const FIRST_PAGE_SIZE = 15;
const NEXT_PAGE_SIZE = 25;
/** Лотов с площадки: для флора хватает нескольких, для просмотра витрины — нет. */
const LOTS_LIMIT = 30;
const LOTS_LIMIT_RANGE = 100;

interface SessionState {
  id: string;
  query: SearchQuery;
  filters: Filters;
  collectionShort: string;
  collectionName: string;
  sources: MarketKey[];
  pagers: Map<MarketKey, AsyncGenerator<TradeEvent[]>>;
  exhausted: Set<MarketKey>;
  inflight: Set<MarketKey>;
  seen: Set<string>;
  trades: TradeDto[];
  floors: Map<string, number>;
  /** Активные лоты по площадкам — то, что прямо сейчас можно купить. */
  lots: Map<string, TradeDto[]>;
  errors: Record<string, string>;
  official: OfficialValue | null;
  colors: Record<string, { center: number; edge: number }>;
  createdAt: number;
  lastAccess: number;
  lastLiveAt: number;
  lastFloorsAt: number;
  cancelled: boolean;
}

export interface SearchSnapshot {
  sessionId: string;
  query: SearchQuery;
  trades: TradeDto[];
  stats: Stats;
  floors: FloorInfo[];
  listings: TradeDto[];
  official: OfficialValue | null;
  errors: Record<string, string>;
  finished: boolean;
  loading: string[];
  fromCache: boolean;
}

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    private readonly config: ConfigService,
    private readonly markets: MarketsRegistry,
    private readonly catalog: CatalogService,
    private readonly rates: RatesService,
    private readonly telegramMarket: TelegramMarketService,
    private readonly gateway: EventsGateway,
    @InjectRepository(TradeEntity)
    private readonly tradesRepo: Repository<TradeEntity>,
    @InjectRepository(ListingEntity)
    private readonly listingsRepo: Repository<ListingEntity>,
  ) {}

  // ------------------------------------------------------------------ сессии
  async create(query: SearchQuery): Promise<SearchSnapshot> {
    // Новый поиск отменяет предыдущий, иначе старая сессия продолжала бы
    // догружать свою коллекцию и слать события во фронт.
    if (query.previousSessionId) this.close(query.previousSessionId);

    const collection = await this.catalog.resolve(query.collection);
    const collectionName = collection?.name ?? query.collection;
    const collectionShort = collection?.shortName ?? slugify(query.collection);

    const sources = (query.sources?.length ? query.sources : DEFAULT_SOURCES).filter((key) =>
      this.markets.keys().includes(key),
    );
    const filters: Filters = {
      collection: collectionName,
      model: query.model ?? null,
      backdrop: query.backdrop ?? null,
      symbol: query.symbol ?? null,
      number: query.number ?? null,
      minPrice: positive(query.minPrice),
      maxPrice: positive(query.maxPrice),
    };

    const session: SessionState = {
      id: randomUUID(),
      query: { ...query, collection: collectionName, sources },
      filters,
      collectionShort,
      collectionName,
      sources,
      pagers: new Map(),
      exhausted: new Set(),
      inflight: new Set(),
      seen: new Set(),
      trades: [],
      floors: new Map(),
      lots: new Map(),
      errors: {},
      official: null,
      colors: await this.catalog.colorMap(collectionName),
      createdAt: Date.now(),
      lastAccess: Date.now(),
      lastLiveAt: Date.now(),
      lastFloorsAt: 0,
      cancelled: false,
    };
    this.sessions.set(session.id, session);

    // Сразу отдаём то, что уже есть в базе — фронт рисует таблицу без ожидания сети.
    const cached = await this.loadFromDatabase(session, 60);
    this.mergeTrades(session, cached);

    // Остальное качаем в фоне и шлём по WebSocket по мере поступления.
    void this.bootstrap(session);

    return this.snapshot(session, cached.length > 0);
  }

  /** Останавливает сессию: генераторы закрываются, события больше не шлются. */
  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.cancelled = true;
    for (const pager of session.pagers.values()) {
      void pager.return?.(undefined as never).catch(() => undefined);
    }
    session.pagers.clear();
    this.sessions.delete(sessionId);
  }

  get(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new NotFoundException('Сессия поиска не найдена — начни поиск заново');
    session.lastAccess = Date.now();
    return session;
  }

  snapshot(session: SessionState, fromCache = false): SearchSnapshot {
    return {
      sessionId: session.id,
      query: session.query,
      trades: session.trades,
      stats: session.trades.length ? computeStats(session.trades) : emptyStats(),
      floors: this.floorList(session),
      listings: this.lotList(session),
      official: session.official,
      errors: session.errors,
      finished: this.isFinished(session),
      loading: [...session.inflight].map((key) => this.markets.get(key)?.title ?? key),
      fromCache,
    };
  }

  private isFinished(session: SessionState): boolean {
    const withHistory = session.sources.filter((key) => this.markets.get(key)?.providesHistory);
    return withHistory.every((key) => session.exhausted.has(key)) && session.inflight.size === 0;
  }

  /** Лоты всех площадок одним списком: сначала самые дешёвые. */
  private lotList(session: SessionState): TradeDto[] {
    return [...session.lots.values()]
      .flat()
      .sort((a, b) => a.priceTon - b.priceTon)
      .slice(0, 150);
  }

  private floorList(session: SessionState): FloorInfo[] {
    return [...session.floors.entries()]
      .map(([market, priceTon]) => ({
        market,
        priceTon,
        priceUsd: this.rates.usd(priceTon),
        stars: this.rates.stars(priceTon),
      }))
      .sort((a, b) => a.priceTon - b.priceTon);
  }

  // ------------------------------------------------------------- наполнение
  /** Стартовый залп: все площадки параллельно, каждая отдаёт результат сразу. */
  private async bootstrap(session: SessionState): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    for (const key of session.sources) {
      const client = this.markets.get(key);
      if (!client) continue;
      if (client.unsupportedReason?.(session.filters)) {
        session.errors[client.title] = client.unsupportedReason(session.filters)!;
        session.exhausted.add(key);
        continue;
      }
      if (client.providesHistory) jobs.push(this.fetchPage(session, key, FIRST_PAGE_SIZE));
      if (client.providesListings) jobs.push(this.fetchListings(session, key));
    }
    jobs.push(this.loadOfficial(session));
    await Promise.allSettled(jobs);
    session.lastFloorsAt = Date.now();
    if (!session.cancelled) this.gateway.emitDone(session.id, this.snapshot(session));
  }

  /**
   * Одна страница истории с одной площадки. Пришедшее сразу же уходит во фронт,
   * не дожидаясь остальных площадок.
   */
  private async fetchPage(session: SessionState, key: MarketKey, pageSize = NEXT_PAGE_SIZE): Promise<TradeDto[]> {
    const client = this.markets.get(key);
    if (!client?.providesHistory || session.cancelled) return [];
    if (session.exhausted.has(key) || session.inflight.has(key)) return [];

    session.inflight.add(key);
    this.gateway.emitProgress(session.id, `${client.title}: качаю…`);
    try {
      let pager = session.pagers.get(key);
      if (!pager) {
        pager = client.historyPages(session.filters, {
          onlySales: session.query.onlySales ?? true,
          pageSize,
        });
        session.pagers.set(key, pager);
      }
      const page = await pager.next();
      if (session.cancelled) return [];
      if (page.done) {
        session.exhausted.add(key);
        return [];
      }
      const events = page.value ?? [];
      // В кеш кладём всё, что пришло, а на экран — только попавшее в диапазон:
      // иначе сужение цены обеднило бы базу и медианы поехали бы.
      if (events.length) void this.persistTrades(session, events);
      const added = this.mergeTrades(session, this.toDto(session, this.inRange(session, events)));
      delete session.errors[client.title];
      if (added.length) {
        session.inflight.delete(key);
        this.gateway.emitTrades(session.id, added, this.snapshot(session), client.title);
      }
      return added;
    } catch (error) {
      session.errors[client.title] = String((error as Error).message ?? error);
      session.exhausted.add(key);
      return [];
    } finally {
      session.inflight.delete(key);
    }
  }

  /** Активные лоты одной площадки: флор уходит во фронт сразу, как посчитан. */
  private async fetchListings(session: SessionState, key: MarketKey): Promise<void> {
    const client = this.markets.get(key);
    if (!client?.providesListings || session.cancelled) return;
    try {
      // С диапазоном цен витрина — самостоятельный экран «что можно купить»,
      // поэтому лотов берём заметно больше, чем нужно для одного флора.
      const wide = session.filters.minPrice != null || session.filters.maxPrice != null;
      const lots = await client.listings(session.filters, wide ? LOTS_LIMIT_RANGE : LOTS_LIMIT);
      if (session.cancelled) return;
      // Флор считаем по лотам внутри диапазона: при поиске «от 70 до 90»
      // интересна самая дешёвая покупка в бюджете, а не общий флор коллекции.
      const visible = this.inRange(session, lots).filter((lot) => lot.priceTon > 0);
      const fresh = this.toDto(session, visible).slice(0, LOTS_LIMIT_RANGE);
      const before = (session.lots.get(client.title) ?? []).map((lot) => lot.id).join();
      session.lots.set(client.title, fresh);
      const prices = visible.map((lot) => lot.priceTon);
      const floor = prices.length ? Math.min(...prices) : null;
      const changed = floor !== null && session.floors.get(client.title) !== floor;
      if (floor !== null) session.floors.set(client.title, floor);
      delete session.errors[`${client.title} · лоты`];
      // Шлём, только когда витрина реально изменилась — иначе это шум в эфире.
      if (changed || before !== fresh.map((lot) => lot.id).join()) {
        this.gateway.emitFloors(session.id, this.floorList(session), this.snapshot(session));
      }
      await this.persistListings(session, lots);
    } catch (error) {
      session.errors[`${client.title} · лоты`] = String((error as Error).message ?? error);
    }
  }

  /** Догрузка при прокрутке: следующая страница со всех площадок параллельно. */
  async loadMore(sessionId: string): Promise<TradeDto[]> {
    const session = this.get(sessionId);
    const results = await Promise.allSettled(
      session.sources.map((key) => this.fetchPage(session, key)),
    );
    const added = results.flatMap((result) =>
      result.status === 'fulfilled' ? result.value : [],
    );
    if (!added.length && !session.cancelled) {
      this.gateway.emitDone(session.id, this.snapshot(session));
    }
    return added;
  }

  /** Живое обновление: свежая первая страница с каждой площадки, только новое. */
  async refreshNew(session: SessionState): Promise<TradeDto[]> {
    const jobs = session.sources.map(async (key) => {
      const client = this.markets.get(key);
      if (!client?.providesHistory || client.unsupportedReason?.(session.filters)) return [];
      if (session.inflight.has(key)) return [];
      try {
        const pager = client.historyPages(session.filters, {
          onlySales: session.query.onlySales ?? true,
          pageSize: FIRST_PAGE_SIZE,
        });
        const page = await pager.next();
        await pager.return?.(undefined as never);
        if (page.done || session.cancelled) return [];
        const events = page.value ?? [];
        if (events.length) void this.persistTrades(session, events);
        const added = this.mergeTrades(session, this.toDto(session, this.inRange(session, events)));
        if (added.length) {
          this.gateway.emitTrades(session.id, added, this.snapshot(session), client.title);
        }
        return added;
      } catch (error) {
        session.errors[client.title] = String((error as Error).message ?? error);
        return [];
      }
    });
    const results = await Promise.allSettled(jobs);
    session.lastLiveAt = Date.now();
    return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  }

  /** Обновление флоров: тоже параллельно по всем площадкам. */
  async refreshFloors(session: SessionState): Promise<FloorInfo[]> {
    await Promise.allSettled(session.sources.map((key) => this.fetchListings(session, key)));
    session.lastFloorsAt = Date.now();
    return this.floorList(session);
  }

  private async loadOfficial(session: SessionState): Promise<void> {
    if (!session.sources.includes('telegram')) return;
    try {
      const lots = await this.telegramMarket.listings(session.filters, 1);
      const slug = lots[0]?.giftName;
      if (slug && !session.cancelled) {
        session.official = await this.telegramMarket.valueInfo(slug);
        this.gateway.emitFloors(session.id, this.floorList(session), this.snapshot(session));
      }
    } catch (error) {
      this.logger.debug(`Оценка Telegram: ${String(error)}`);
    }
  }

  // ------------------------------------------------------------------ данные
  private dedupKey(event: TradeEvent): string {
    return (
      event.externalId ??
      `${event.ts.toISOString()}|${event.number ?? ''}|${event.priceTon}|${event.kind}`
    ).slice(0, 128);
  }

  /** Отсев по ценовому диапазону сессии (без диапазона — возвращает как есть). */
  private inRange(session: SessionState, events: TradeEvent[]): TradeEvent[] {
    const { minPrice, maxPrice } = session.filters;
    if (minPrice == null && maxPrice == null) return events;
    return events.filter((event) => inPriceRange(session.filters, event.priceTon));
  }

  private mergeTrades(session: SessionState, trades: TradeDto[]): TradeDto[] {
    const added: TradeDto[] = [];
    for (const trade of trades) {
      if (session.seen.has(trade.id)) continue;
      session.seen.add(trade.id);
      added.push(trade);
    }
    if (added.length) {
      session.trades = [...session.trades, ...added].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    }
    return added;
  }

  private toDto(session: SessionState, events: TradeEvent[]): TradeDto[] {
    return events.map((event) => this.eventToDto(session, event));
  }

  private eventToDto(session: SessionState, event: TradeEvent): TradeDto {
    const ts = event.ts instanceof Date ? event.ts : new Date(event.ts);
    const colors = event.backdrop ? session.colors[event.backdrop] ?? null : null;
    // Сделку считаем по курсу на её дату, а лот — по текущему: платить за него
    // придётся сегодня, а дата у лота — это когда его выставили.
    const rateAt = event.kind === 'active_listing' ? null : ts;
    return {
      id: `${event.market}:${this.dedupKey(event)}`,
      market: event.market,
      kind: event.kind,
      collection: event.collection,
      model: event.model ?? null,
      backdrop: event.backdrop ?? null,
      symbol: event.symbol ?? null,
      number: event.number ?? null,
      priceTon: event.priceTon,
      priceUsd: this.rates.usd(event.priceTon, rateAt),
      stars: this.rates.stars(event.priceTon, rateAt, 'buy'),
      starsSell: this.rates.stars(event.priceTon, rateAt, 'sell'),
      ts: ts.toISOString(),
      giftName: event.giftName ?? null,
      link: giftLink(event.giftName, event.collection, event.number),
      image: event.model
        ? `/images/${session.collectionShort}/${encodeURIComponent(event.model)}.png`
        : null,
      backdropColors: colors,
    };
  }

  private async persistTrades(session: SessionState, events: TradeEvent[]): Promise<void> {
    if (!events.length) return;
    const rows = events.map((event) => ({
      market: event.market,
      kind: event.kind,
      collectionShort: session.collectionShort,
      collection: event.collection,
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
    try {
      await this.tradesRepo
        .createQueryBuilder()
        .insert()
        .into(TradeEntity)
        .values(rows)
        .orIgnore()
        .execute();
    } catch (error) {
      this.logger.warn(`Не удалось сохранить сделки: ${String((error as Error).message)}`);
    }
  }

  private async persistListings(session: SessionState, lots: TradeEvent[]): Promise<void> {
    if (!lots.length) return;
    const market = lots[0].market;
    try {
      await this.listingsRepo.delete({ collectionShort: session.collectionShort, market });
      await this.listingsRepo.save(
        lots.map((lot) =>
          this.listingsRepo.create({
            market: lot.market,
            collectionShort: session.collectionShort,
            collection: lot.collection,
            model: lot.model ?? null,
            backdrop: lot.backdrop ?? null,
            symbol: lot.symbol ?? null,
            number: lot.number ?? null,
            priceTon: lot.priceTon,
            giftName: lot.giftName ?? null,
            fetchedAt: new Date(),
          }),
        ),
        { chunk: 200 },
      );
    } catch (error) {
      this.logger.debug(`Лоты ${market}: ${String((error as Error).message)}`);
    }
  }

  /** Быстрый первый экран: что уже накоплено в базе по этому фильтру. */
  private async loadFromDatabase(session: SessionState, limit: number): Promise<TradeDto[]> {
    const builder = this.tradesRepo
      .createQueryBuilder('trade')
      .where('trade.collectionShort = :short', { short: session.collectionShort })
      .andWhere('trade.kind = :kind', { kind: 'sale' })
      .orderBy('trade.ts', 'DESC')
      .limit(limit);
    if (session.filters.model) builder.andWhere('trade.model = :model', { model: session.filters.model });
    if (session.filters.backdrop) builder.andWhere('trade.backdrop = :backdrop', { backdrop: session.filters.backdrop });
    if (session.filters.symbol) builder.andWhere('trade.symbol = :symbol', { symbol: session.filters.symbol });
    if (session.filters.number) builder.andWhere('trade.number = :number', { number: session.filters.number });
    if (session.filters.minPrice != null) {
      builder.andWhere('trade.priceTon >= :minPrice', { minPrice: session.filters.minPrice });
    }
    if (session.filters.maxPrice != null) {
      builder.andWhere('trade.priceTon <= :maxPrice', { maxPrice: session.filters.maxPrice });
    }
    if (session.sources.length) {
      builder.andWhere('trade.market IN (:...markets)', {
        markets: session.sources.map((key) => this.markets.get(key)?.title ?? key),
      });
    }

    const rows = await builder.getMany();
    return rows.map((row) =>
      this.eventToDto(session, {
        market: row.market,
        kind: row.kind,
        collection: row.collection,
        model: row.model,
        backdrop: row.backdrop,
        symbol: row.symbol,
        number: row.number,
        priceTon: Number(row.priceTon),
        ts: row.ts,
        giftName: row.giftName,
        externalId: row.dedupKey,
      }),
    );
  }

  // -------------------------------------------------------------- live-цикл
  @Interval(5000)
  async liveTick(): Promise<void> {
    const live = this.config.get<{ tradesIntervalMs: number; floorsIntervalMs: number; sessionTtlMs: number }>('live')!;
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (session.cancelled || now - session.lastAccess > live.sessionTtlMs) {
        this.close(session.id);
        continue;
      }
      if (!this.gateway.hasSubscribers(session.id)) continue;
      if (session.inflight.size) continue;
      if (now - session.lastLiveAt >= live.tradesIntervalMs) {
        await this.refreshNew(session).catch((error) =>
          this.logger.debug(`Живое обновление: ${String(error)}`),
        );
      }
      if (now - session.lastFloorsAt >= live.floorsIntervalMs) {
        await this.refreshFloors(session).catch((error) =>
          this.logger.debug(`Флоры: ${String(error)}`),
        );
      }
    }
  }

  /** Сколько сделок по этой коллекции уже лежит в базе. */
  async storedCount(collectionShort: string): Promise<number> {
    return this.tradesRepo.count({ where: { collectionShort } });
  }
}

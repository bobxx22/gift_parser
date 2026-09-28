/**
 * Снимок минимальных цен по всему рынку.
 *
 * Обходить 120 коллекций по одной долго, а весь рынок помещается в полтора
 * десятка запросов: у MRKT список коллекций сразу с флором, у Portals — список
 * коллекций и роут атрибутов, который принимает по десять коллекций за раз и
 * возвращает флор каждой модели и каждого фона. Снимок целиком обновляется за
 * несколько секунд, поэтому мы держим его свежим и ищем выгодные позиции уже
 * по базе, а не по площадкам.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';

import { slugify } from '../common/utils';
import { CollectionEntity, FloorEntity } from '../database/entities';
import { MrktService } from '../markets/mrkt.service';
import { PortalsService } from '../markets/portals.service';

/** Сколько коллекций отдаём в один запрос атрибутов Portals. */
const ATTR_BATCH = 10;
/** Строки, которых давно нет в выдаче площадок, считаем протухшими. */
const STALE_HOURS = 6;
/**
 * Вес свежего снимка в скользящей средней. 0.1 — это «память» примерно на
 * десяток снимков: при обновлении раз в пять минут опора помнит последний час.
 */
const BASELINE_ALPHA = 0.1;

export interface FloorsReport {
  markets: Record<string, number>;
  collections: number;
  models: number;
  backdrops: number;
  changed: number;
  ms: number;
}

type Row = Pick<
  FloorEntity,
  'market' | 'collectionShort' | 'collection' | 'kind' | 'value' | 'floorTon' | 'supply' | 'listedCount'
>;

@Injectable()
export class FloorsService implements OnModuleInit {
  private readonly logger = new Logger(FloorsService.name);
  private running = false;
  private lastRunAt = 0;
  private lastReport: FloorsReport | null = null;
  private lastError: string | null = null;
  /** Пауза между полными снимками. */
  private intervalMs = 5 * 60_000;

  constructor(
    private readonly mrkt: MrktService,
    private readonly portals: PortalsService,
    @InjectRepository(FloorEntity)
    private readonly floorsRepo: Repository<FloorEntity>,
    @InjectRepository(CollectionEntity)
    private readonly collectionsRepo: Repository<CollectionEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Первый снимок делаем не на старте, а через полминуты: пусть сначала
    // поднимется Telegram-сессия, иначе Portals ответит 401.
    this.lastRunAt = Date.now() - this.intervalMs + 30_000;
  }

  setInterval(ms: number): void {
    this.intervalMs = Math.min(3600_000, Math.max(60_000, ms));
  }

  /** Размер снимка читаем из базы: после перезапуска отчёт в памяти пустой. */
  async status() {
    const row = await this.floorsRepo
      .createQueryBuilder('floor')
      .select("count(*) filter (where floor.kind = 'collection')", 'collections')
      .addSelect("count(*) filter (where floor.kind = 'model')", 'models')
      .addSelect("count(*) filter (where floor.kind = 'backdrop')", 'backdrops')
      .addSelect('max(floor.updatedAt)', 'updatedAt')
      .getRawOne<{ collections: string; models: string; backdrops: string; updatedAt: Date | null }>();

    return {
      running: this.running,
      intervalMs: this.intervalMs,
      lastRunAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      lastError: this.lastError,
      markets: this.lastReport?.markets ?? {},
      collections: Number(row?.collections ?? 0),
      models: Number(row?.models ?? 0),
      backdrops: Number(row?.backdrops ?? 0),
      changed: this.lastReport?.changed ?? 0,
      ms: this.lastReport?.ms ?? 0,
    };
  }

  @Interval(15_000)
  async tick(): Promise<void> {
    if (this.running || Date.now() - this.lastRunAt < this.intervalMs) return;
    await this.refresh().catch((error) => {
      this.logger.warn(`Снимок флоров: ${String((error as Error).message)}`);
    });
  }

  /** Полный снимок: коллекции с обеих площадок + модели и фоны с Portals. */
  async refresh(): Promise<FloorsReport> {
    if (this.running) return this.lastReport ?? this.emptyReport();
    this.running = true;
    this.lastRunAt = Date.now();
    const started = new Date();
    const rows: Row[] = [];
    const perMarket: Record<string, number> = {};
    let models = 0;
    let backdrops = 0;

    try {
      // Названия коллекций держим в одном написании с каталогом.
      const known = new Map<string, string>();
      for (const item of await this.collectionsRepo.find()) known.set(item.shortName, item.name);

      // --- MRKT: один запрос на весь список
      try {
        for (const item of await this.mrkt.collectionFloors()) {
          const short = slugify(item.name);
          rows.push({
            market: this.mrkt.title,
            collectionShort: short,
            collection: known.get(short) ?? item.name,
            kind: 'collection',
            value: '',
            floorTon: item.floorTon,
            supply: null,
            listedCount: null,
          });
        }
        perMarket[this.mrkt.title] = rows.length;
      } catch (error) {
        this.logger.warn(`MRKT флоры: ${String((error as Error).message)}`);
      }

      // --- Portals: коллекции, затем атрибуты пачками
      let portalsRows = 0;
      const shorts: string[] = [];
      try {
        for (const item of await this.portals.collections(true)) {
          if (!item.short_name) continue;
          shorts.push(item.short_name);
          const floorTon = Number(item.floor_price);
          if (!Number.isFinite(floorTon) || floorTon <= 0) continue;
          rows.push({
            market: this.portals.title,
            collectionShort: item.short_name,
            collection: known.get(item.short_name) ?? item.name ?? item.short_name,
            kind: 'collection',
            value: '',
            floorTon,
            supply: item.supply ?? null,
            listedCount: item.listed_count ?? null,
          });
          portalsRows += 1;
        }
      } catch (error) {
        this.logger.warn(`Portals коллекции: ${String((error as Error).message)}`);
      }

      for (let index = 0; index < shorts.length; index += ATTR_BATCH) {
        const chunk = shorts.slice(index, index + ATTR_BATCH);
        let blocks: Awaited<ReturnType<PortalsService['attributes']>>;
        try {
          blocks = await this.portals.attributes(chunk);
        } catch (error) {
          this.logger.debug(`Portals атрибуты ${chunk[0]}…: ${String((error as Error).message)}`);
          continue;
        }
        for (const [short, block] of Object.entries(blocks)) {
          // Символ на цену почти не влияет — его в снимок не берём.
          for (const [kind, items] of [
            ['model', block.models],
            ['backdrop', block.backdrops],
          ] as const) {
            for (const item of items ?? []) {
              const floorTon = Number(item.floor_price);
              if (!item?.name || !Number.isFinite(floorTon) || floorTon <= 0) continue;
              rows.push({
                market: this.portals.title,
                collectionShort: short,
                collection: known.get(short) ?? short,
                kind,
                value: String(item.name).slice(0, 128),
                floorTon,
                supply: item.supply ?? null,
                listedCount: null,
              });
              portalsRows += 1;
              if (kind === 'model') models += 1;
              else backdrops += 1;
            }
          }
        }
      }
      perMarket[this.portals.title] = portalsRows;

      const changed = await this.save(rows, started);
      await this.dropStale(started);

      this.lastReport = {
        markets: perMarket,
        collections: rows.filter((row) => row.kind === 'collection').length,
        models,
        backdrops,
        changed,
        ms: Date.now() - started.getTime(),
      };
      this.lastError = null;
      this.logger.log(
        `Флоры: ${rows.length} строк (${this.lastReport.collections} коллекций, ` +
          `${models} моделей, ${backdrops} фонов), изменилось ${changed}, ${this.lastReport.ms} мс`,
      );
      return this.lastReport;
    } catch (error) {
      this.lastError = String((error as Error).message ?? error);
      throw error;
    } finally {
      this.running = false;
      this.lastRunAt = Date.now();
    }
  }

  /**
   * Пишем снимок, сохраняя предыдущее значение: по паре floorTon/prevTon видно,
   * что флор только что упал, а changedAt показывает, когда это случилось.
   */
  private async save(input: Row[], now: Date): Promise<number> {
    if (!input.length) return 0;
    // У площадок попадаются разные коллекции с одинаковым slug («Fine Pen» и
    // «Fine  Pen»), а upsert не переваривает два одинаковых ключа в одной пачке.
    // Оставляем минимальную цену — это и есть флор.
    const unique = new Map<string, Row>();
    for (const row of input) {
      const key = this.key(row);
      const seen = unique.get(key);
      if (!seen || row.floorTon < seen.floorTon) unique.set(key, row);
    }
    const rows = [...unique.values()];
    const previous = new Map<
      string,
      { floorTon: number; prevTon: number | null; baselineTon: number | null; changedAt: Date }
    >();
    for (const row of await this.floorsRepo.find()) {
      previous.set(this.key(row), {
        floorTon: row.floorTon,
        prevTon: row.prevTon,
        baselineTon: row.baselineTon,
        changedAt: row.changedAt,
      });
    }

    let changed = 0;
    const payload = rows.map((row) => {
      const old = previous.get(this.key(row));
      const moved = old != null && old.floorTon !== row.floorTon;
      if (moved) changed += 1;
      // Первый снимок задаёт опору сам себе — находок из него не будет,
      // и это правильно: сравнивать пока не с чем.
      const baseline =
        old?.baselineTon == null
          ? row.floorTon
          : old.baselineTon * (1 - BASELINE_ALPHA) + row.floorTon * BASELINE_ALPHA;
      return {
        ...row,
        prevTon: moved ? old!.floorTon : old?.prevTon ?? null,
        baselineTon: Math.round(baseline * 10_000) / 10_000,
        changedAt: moved || !old ? now : old.changedAt,
        updatedAt: now,
      };
    });

    for (let start = 0; start < payload.length; start += 500) {
      await this.floorsRepo.upsert(payload.slice(start, start + 500), [
        'market',
        'collectionShort',
        'kind',
        'value',
      ]);
    }
    return changed;
  }

  /** Позиции, которых давно нет в выдаче площадок, из снимка убираем. */
  private async dropStale(now: Date): Promise<void> {
    const edge = new Date(now.getTime() - STALE_HOURS * 3600_000);
    await this.floorsRepo.delete({ updatedAt: LessThan(edge) });
  }

  private key(row: { market: string; collectionShort: string; kind: string; value: string }): string {
    return `${row.market}|${row.collectionShort}|${row.kind}|${row.value}`;
  }

  private emptyReport(): FloorsReport {
    return { markets: {}, collections: 0, models: 0, backdrops: 0, changed: 0, ms: 0 };
  }
}

/**
 * Каталог подарков: коллекции, модели, фоны и символы.
 *
 * Данные лежат в Postgres, обновляются с публичных роутов Portals, а цвета фонов —
 * из официального API Telegram. Картинки моделей и символов берутся из папки
 * downloaded_collections, недостающие докачиваются со стораджа Portals.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios from 'axios';
import { existsSync } from 'fs';
import { mkdir, readdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { In, Repository } from 'typeorm';

import { AttributeKind, BackdropColors } from '../common/types';
import { rank, safeFileName, slugify } from '../common/utils';
import { AttributeEntity, CollectionEntity } from '../database/entities';
import { PortalsService } from '../markets/portals.service';
import { TelegramMarketService } from '../markets/telegram-market.service';

const STORAGE = 'https://storage.portal-market.com/portals-market/gifts';
const KIND_DIR: Record<string, string> = { models: 'models/png', symbols: 'patterns' };

export interface CollectionDto {
  shortName: string;
  name: string;
  floorPrice: number | null;
  supply: number | null;
  listedCount: number | null;
  volume: number | null;
  icon: string | null;
  subtitle: string;
}

export interface AttributeDto {
  name: string;
  kind: AttributeKind;
  floorPrice: number | null;
  supply: number | null;
  rarity: number | null;
  image: string | null;
  colors: BackdropColors | null;
  subtitle: string;
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  private readonly imagesDir: string;
  private backdropColors = new Map<string, BackdropColors>();

  constructor(
    private readonly config: ConfigService,
    private readonly portals: PortalsService,
    private readonly telegramMarket: TelegramMarketService,
    @InjectRepository(CollectionEntity)
    private readonly collectionsRepo: Repository<CollectionEntity>,
    @InjectRepository(AttributeEntity)
    private readonly attributesRepo: Repository<AttributeEntity>,
  ) {
    this.imagesDir = this.config.get<string>('imagesDir')!;
  }

  // ------------------------------------------------------------- коллекции
  async collections(query = '', limit = 60): Promise<CollectionDto[]> {
    const rows = await this.collectionsRepo.find();
    const scored = rows
      .map((row) => ({ row, score: Math.max(rank(row.name, query), rank(row.shortName, query)) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score || (b.row.volume ?? 0) - (a.row.volume ?? 0));
    return scored.slice(0, limit).map((item) => this.toCollectionDto(item.row));
  }

  async resolve(nameOrShort: string): Promise<CollectionEntity | null> {
    if (!nameOrShort) return null;
    const target = nameOrShort.trim();
    const flat = slugify(target);
    const rows = await this.collectionsRepo.find({
      where: [{ shortName: flat }, { name: target }],
    });
    if (rows.length) return rows[0];
    const all = await this.collectionsRepo.find();
    return all.find((row) => slugify(row.name) === flat) ?? null;
  }

  private toCollectionDto(row: CollectionEntity): CollectionDto {
    const parts: string[] = [];
    if (row.floorPrice) parts.push(`флор ${format(row.floorPrice)} TON`);
    if (row.supply) parts.push(`${row.supply.toLocaleString('ru-RU')} шт`);
    return {
      shortName: row.shortName,
      name: row.name,
      floorPrice: row.floorPrice,
      supply: row.supply,
      listedCount: row.listedCount,
      volume: row.volume,
      icon: `/images/${row.shortName}/__icon__.png`,
      subtitle: parts.join(' · '),
    };
  }

  // -------------------------------------------------------------- атрибуты
  async attributes(collection: string, kind: AttributeKind, query = '', limit = 80): Promise<AttributeDto[]> {
    const found = await this.resolve(collection);
    if (!found) return [];
    const rows = await this.attributesRepo.find({ where: { collectionShort: found.shortName, kind } });
    const scored = rows
      .map((row) => ({ row, score: rank(row.name, query) }))
      .filter((item) => item.score >= 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.row.floorPrice ?? 0) - (a.row.floorPrice ?? 0) ||
          a.row.name.localeCompare(b.row.name),
      );
    return scored.slice(0, limit).map((item) => this.toAttributeDto(found.shortName, item.row));
  }

  private toAttributeDto(short: string, row: AttributeEntity): AttributeDto {
    const parts: string[] = [];
    if (row.floorPrice) parts.push(`флор ${format(row.floorPrice)} TON`);
    if (row.supply) parts.push(`${row.supply.toLocaleString('ru-RU')} шт`);
    if (row.rarity) parts.push(`${row.rarity}‰`);
    return {
      name: row.name,
      kind: row.kind as AttributeKind,
      floorPrice: row.floorPrice,
      supply: row.supply,
      rarity: row.rarity,
      image:
        row.kind === 'backdrops'
          ? null
          : `/images/${short}/${encodeURIComponent(row.name)}.png?kind=${row.kind}`,
      colors: (row.colors as unknown as BackdropColors) ?? null,
      subtitle: parts.join(' · '),
    };
  }

  /** Цвета фона для карточки подарка (кешируются в памяти на процесс). */
  async colorsFor(collection: string, backdrop?: string | null): Promise<BackdropColors | null> {
    if (!backdrop) return null;
    const cached = this.backdropColors.get(backdrop);
    if (cached) return cached;
    const found = await this.resolve(collection);
    if (!found) return null;
    const row = await this.attributesRepo.findOne({
      where: { collectionShort: found.shortName, kind: 'backdrops', name: backdrop },
    });
    const colors = (row?.colors as unknown as BackdropColors) ?? null;
    if (colors) this.backdropColors.set(backdrop, colors);
    return colors;
  }

  async colorMap(collection: string): Promise<Record<string, BackdropColors>> {
    const found = await this.resolve(collection);
    if (!found) return {};
    const rows = await this.attributesRepo.find({
      where: { collectionShort: found.shortName, kind: 'backdrops' },
    });
    const out: Record<string, BackdropColors> = {};
    for (const row of rows) {
      if (row.colors) out[row.name] = row.colors as unknown as BackdropColors;
    }
    return out;
  }

  // -------------------------------------------------------------- картинки
  attributeUrl(short: string, kind: string, name: string): string | null {
    const dir = KIND_DIR[kind];
    if (!dir) return null;
    return `${STORAGE}/${short}/${dir}/${slugify(name)}.png`;
  }

  /** Локальный файл картинки; при отсутствии — скачивает со стораджа Portals. */
  async imageFile(short: string, name: string, kind = 'models'): Promise<string | null> {
    const folder = join(this.imagesDir, short);
    for (const candidate of [safeFileName(name), name, slugify(name)]) {
      const path = join(folder, `${candidate}.png`);
      if (existsSync(path)) return path;
    }
    const url = this.attributeUrl(short, kind, name);
    if (!url) return null;
    try {
      const response = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 20_000 });
      if (response.status !== 200) return null;
      await mkdir(folder, { recursive: true });
      const path = join(folder, `${safeFileName(name)}.png`);
      await writeFile(path, Buffer.from(response.data));
      return path;
    } catch {
      return null;
    }
  }

  /** Иконка коллекции: первая локальная картинка либо photo_url из Portals. */
  async iconFile(short: string): Promise<string | null> {
    const folder = join(this.imagesDir, short);
    if (existsSync(folder)) {
      const files = (await readdir(folder)).filter((file) => file.toLowerCase().endsWith('.png')).sort();
      if (files.length) return join(folder, files[0]);
    }
    const row = await this.collectionsRepo.findOne({ where: { shortName: short } });
    const url =
      row?.photoUrl ||
      (await this.attributesRepo.findOne({ where: { collectionShort: short, kind: 'models' } }))?.imageUrl;
    if (!url) return null;
    try {
      const response = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 20_000 });
      if (response.status !== 200) return null;
      await mkdir(folder, { recursive: true });
      const path = join(folder, '__icon__.png');
      await writeFile(path, Buffer.from(response.data));
      return path;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ обновление
  /** Тянет весь каталог с публичных роутов Portals и складывает в Postgres. */
  async refresh(onProgress?: (text: string) => void, batchSize = 10): Promise<{ collections: number; attributes: number }> {
    onProgress?.('Portals: список коллекций…');
    const collections = await this.portals.collections(true);
    const rows = collections
      .filter((item) => item.short_name)
      .map((item) => ({
        shortName: item.short_name,
        name: item.name ?? item.short_name,
        portalsId: item.id ?? null,
        floorPrice: numberOrNull(item.floor_price),
        supply: item.supply ?? null,
        listedCount: item.listed_count ?? null,
        volume: numberOrNull(item.volume),
        dayVolume: numberOrNull(item.day_volume),
        photoUrl: item.photo_url || null,
        isNew: Boolean(item.is_new),
      }));
    await this.collectionsRepo.upsert(rows, ['shortName']);

    const shorts = rows.map((row) => row.shortName);
    let attributes = 0;
    for (let index = 0; index < shorts.length; index += batchSize) {
      const chunk = shorts.slice(index, index + batchSize);
      onProgress?.(`Атрибуты ${Math.min(index + chunk.length, shorts.length)}/${shorts.length}…`);
      let blocks: Awaited<ReturnType<PortalsService['attributes']>>;
      try {
        blocks = await this.portals.attributes(chunk);
      } catch (error) {
        this.logger.warn(`Атрибуты ${chunk[0]}…: ${String((error as Error).message)}`);
        continue;
      }
      const batch: Partial<AttributeEntity>[] = [];
      for (const [short, block] of Object.entries(blocks)) {
        for (const kind of ['models', 'backdrops', 'symbols'] as AttributeKind[]) {
          for (const item of block[kind] ?? []) {
            if (!item?.name) continue;
            batch.push({
              collectionShort: short,
              kind,
              name: String(item.name),
              floorPrice: numberOrNull(item.floor_price),
              supply: item.supply ?? null,
              rarity: item.rarity_per_mille ?? item.rarityPermille ?? null,
              imageUrl: item.url || this.attributeUrl(short, kind, String(item.name)),
            });
          }
        }
      }
      for (let start = 0; start < batch.length; start += 500) {
        await this.attributesRepo.upsert(batch.slice(start, start + 500), ['collectionShort', 'kind', 'name']);
      }
      attributes += batch.length;
    }
    onProgress?.(`Готово: ${rows.length} коллекций, ${attributes} атрибутов`);
    return { collections: rows.length, attributes };
  }

  /** Дописывает цвета фонов из Telegram (нужен вход). */
  async refreshBackdropColors(collection: string): Promise<number> {
    const found = await this.resolve(collection);
    if (!found) return 0;
    const colors = await this.telegramMarket.backdropColors(found.name);
    const names = Object.keys(colors);
    if (!names.length) return 0;
    const rows = await this.attributesRepo.find({
      where: { collectionShort: found.shortName, kind: 'backdrops', name: In(names) },
    });
    for (const row of rows) row.colors = colors[row.name] as unknown as Record<string, number>;
    await this.attributesRepo.save(rows);
    for (const [name, value] of Object.entries(colors)) this.backdropColors.set(name, value);
    return rows.length;
  }
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function format(value: number): string {
  return value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

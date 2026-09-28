/**
 * Загружает в Postgres то, что уже собрано Python-версией:
 *   data.json                -> коллекции, модели, фоны, символы
 *   ton_usd.json             -> курс TON по дням
 *   legacy-python/gift_parser/backdrops.json -> цвета фонов
 *
 *   npm run seed
 */

import 'reflect-metadata';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { DataSource } from 'typeorm';

import configuration from '../config/configuration';
import {
  AttributeEntity,
  CollectionEntity,
  ENTITIES,
  TonRateEntity,
} from '../database/entities';

interface DataJson {
  collections: Record<
    string,
    {
      models?: Array<Record<string, unknown>>;
      symbols?: Array<Record<string, unknown>>;
      backdrops?: Array<Record<string, unknown>>;
    }
  >;
  floor_prices?: Record<string, Record<string, Record<string, string>>>;
  meta?: Record<string, Record<string, unknown>>;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function main(): Promise<void> {
  const config = configuration();
  const dataSource = new DataSource({
    type: 'postgres',
    ...config.database,
    entities: ENTITIES,
  });
  await dataSource.initialize();
  console.log(`Postgres: ${config.database.host}:${config.database.port}/${config.database.database}`);

  // ------------------------------------------------------------- каталог
  if (existsSync(config.dataJson)) {
    const data: DataJson = JSON.parse(await readFile(config.dataJson, 'utf8'));
    const colors: Record<string, Record<string, number>> = existsSync(config.backdropsJson)
      ? JSON.parse(await readFile(config.backdropsJson, 'utf8'))
      : {};

    const collections: Partial<CollectionEntity>[] = [];
    for (const [short, meta] of Object.entries(data.meta ?? {})) {
      collections.push({
        shortName: short,
        name: String(meta.name ?? short),
        portalsId: (meta.id as string) ?? null,
        floorPrice: num(meta.floor_price),
        supply: num(meta.supply),
        listedCount: num(meta.listed_count),
        volume: num(meta.volume),
        dayVolume: num(meta.day_volume),
        photoUrl: (meta.photo_url as string) || null,
        isNew: Boolean(meta.is_new),
      });
    }
    for (const short of Object.keys(data.collections ?? {})) {
      if (!collections.some((row) => row.shortName === short)) {
        collections.push({ shortName: short, name: short });
      }
    }
    if (collections.length) {
      await dataSource.getRepository(CollectionEntity).upsert(collections, ['shortName']);
    }
    console.log(`Коллекций: ${collections.length}`);

    const attributes: Partial<AttributeEntity>[] = [];
    for (const [short, block] of Object.entries(data.collections ?? {})) {
      const floors = data.floor_prices?.[short] ?? {};
      for (const kind of ['models', 'backdrops', 'symbols'] as const) {
        for (const item of block[kind] ?? []) {
          const name = String(item.name ?? '');
          if (!name) continue;
          attributes.push({
            collectionShort: short,
            kind,
            name,
            floorPrice: num(item.floor_price ?? floors[kind]?.[name]),
            supply: num(item.supply),
            rarity: num(item.rarity_per_mille ?? item.rarityPermille),
            imageUrl: (item.url as string) || null,
            colors: kind === 'backdrops' ? (colors[name] ?? null) : null,
          });
        }
      }
    }
    const repo = dataSource.getRepository(AttributeEntity);
    for (let index = 0; index < attributes.length; index += 500) {
      await repo.upsert(attributes.slice(index, index + 500), ['collectionShort', 'kind', 'name']);
      process.stdout.write(`\rАтрибутов: ${Math.min(index + 500, attributes.length)}/${attributes.length}`);
    }
    console.log(`\rАтрибутов: ${attributes.length}                    `);
  } else {
    console.log(`data.json не найден: ${config.dataJson}`);
  }

  // ---------------------------------------------------------------- курс
  if (existsSync(config.ratesJson)) {
    const payload = JSON.parse(await readFile(config.ratesJson, 'utf8')) as {
      source?: string;
      prices?: Record<string, number>;
    };
    const rows = Object.entries(payload.prices ?? {}).map(([day, priceUsd]) => ({
      day,
      priceUsd: Number(priceUsd),
      source: payload.source ?? 'import',
    }));
    const repo = dataSource.getRepository(TonRateEntity);
    for (let index = 0; index < rows.length; index += 500) {
      await repo.upsert(rows.slice(index, index + 500), ['day']);
    }
    console.log(`Курс TON: ${rows.length} дней`);
  } else {
    console.log(`ton_usd.json не найден: ${config.ratesJson} — курс подтянется сам при старте`);
  }

  await dataSource.destroy();
  console.log('Готово.');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

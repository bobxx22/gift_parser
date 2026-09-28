/** Схема Postgres: каталог, сделки, лоты, курс TON и служебные настройки. */

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('collections')
export class CollectionEntity {
  /** Короткое имя, как у Portals и Fragment: heroichelmet. */
  @PrimaryColumn({ type: 'varchar', length: 64 })
  shortName: string;

  @Index()
  @Column({ type: 'varchar', length: 128 })
  name: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  portalsId: string | null;

  @Column({ type: 'double precision', nullable: true })
  floorPrice: number | null;

  @Column({ type: 'int', nullable: true })
  supply: number | null;

  @Column({ type: 'int', nullable: true })
  listedCount: number | null;

  @Column({ type: 'double precision', nullable: true })
  volume: number | null;

  @Column({ type: 'double precision', nullable: true })
  dayVolume: number | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  photoUrl: string | null;

  @Column({ type: 'boolean', default: false })
  isNew: boolean;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

@Entity('attributes')
@Index('attributes_unique', ['collectionShort', 'kind', 'name'], { unique: true })
export class AttributeEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ type: 'varchar', length: 64 })
  collectionShort: string;

  /** models | backdrops | symbols */
  @Column({ type: 'varchar', length: 16 })
  kind: string;

  @Column({ type: 'varchar', length: 128 })
  name: string;

  @Column({ type: 'double precision', nullable: true })
  floorPrice: number | null;

  @Column({ type: 'int', nullable: true })
  supply: number | null;

  @Column({ type: 'double precision', nullable: true })
  rarity: number | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  imageUrl: string | null;

  /** Цвета фона из Telegram: center/edge/pattern/text. */
  @Column({ type: 'jsonb', nullable: true })
  colors: Record<string, number> | null;
}

@Entity('trades')
@Index('trades_unique', ['market', 'dedupKey'], { unique: true })
@Index('trades_lookup', ['collectionShort', 'model', 'ts'])
export class TradeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 24 })
  market: string;

  @Column({ type: 'varchar', length: 32 })
  kind: string;

  @Column({ type: 'varchar', length: 64 })
  collectionShort: string;

  @Column({ type: 'varchar', length: 128 })
  collection: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  model: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  backdrop: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  symbol: string | null;

  @Column({ type: 'int', nullable: true })
  number: number | null;

  @Column({ type: 'double precision' })
  priceTon: number;

  @Index()
  @Column({ type: 'timestamptz' })
  ts: Date;

  @Column({ type: 'varchar', length: 128, nullable: true })
  giftName: string | null;

  @Column({ type: 'double precision', nullable: true })
  oldPrice: number | null;

  /** Ключ дедупликации в пределах площадки. */
  @Column({ type: 'varchar', length: 128 })
  dedupKey: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

@Entity('listings')
@Index('listings_lookup', ['collectionShort', 'market', 'priceTon'])
export class ListingEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 24 })
  market: string;

  @Column({ type: 'varchar', length: 64 })
  collectionShort: string;

  @Column({ type: 'varchar', length: 128 })
  collection: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  model: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  backdrop: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  symbol: string | null;

  @Column({ type: 'int', nullable: true })
  number: number | null;

  @Column({ type: 'double precision' })
  priceTon: number;

  @Column({ type: 'varchar', length: 128, nullable: true })
  giftName: string | null;

  @Index()
  @Column({ type: 'timestamptz' })
  fetchedAt: Date;
}

/**
 * Минимальная цена (флор) в разрезе коллекция / модель / фон.
 *
 * Заполняется пачкой: у Portals есть роут со всеми коллекциями и роут с
 * атрибутами сразу по десятку коллекций, у MRKT — список коллекций с флором.
 * Полный снимок рынка стоит полтора десятка запросов, а не обхода всех
 * коллекций по одной, поэтому обновляется целиком и часто.
 */
@Entity('floors')
@Index('floors_unique', ['market', 'collectionShort', 'kind', 'value'], { unique: true })
@Index('floors_lookup', ['collectionShort', 'kind'])
export class FloorEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 24 })
  market: string;

  @Column({ type: 'varchar', length: 64 })
  collectionShort: string;

  @Column({ type: 'varchar', length: 128 })
  collection: string;

  /** collection — флор всей коллекции, model / backdrop — в разрезе атрибута. */
  @Column({ type: 'varchar', length: 16 })
  kind: string;

  /** Название модели или фона; у флора коллекции — пустая строка. */
  @Column({ type: 'varchar', length: 128, default: '' })
  value: string;

  @Column({ type: 'double precision' })
  floorTon: number;

  /** Предыдущее значение — по нему видно, что флор только что упал. */
  @Column({ type: 'double precision', nullable: true })
  prevTon: number | null;

  /**
   * Опорная цена: скользящая средняя флора по снимкам. С ней и сравниваем,
   * потому что «флор ниже медианы продаж» — это норма, а не находка:
   * флор по определению минимум, медиана — середина.
   */
  @Column({ type: 'double precision', nullable: true })
  baselineTon: number | null;

  @Column({ type: 'int', nullable: true })
  supply: number | null;

  @Column({ type: 'int', nullable: true })
  listedCount: number | null;

  /** Когда флор последний раз менялся (а не когда мы его перечитали). */
  @Column({ type: 'timestamptz' })
  changedAt: Date;

  @Index()
  @Column({ type: 'timestamptz' })
  updatedAt: Date;
}

/** Найденная фоновым сканером сделка заметно ниже медианы. */
@Entity('deals')
@Index('deals_unique', ['market', 'dedupKey'], { unique: true })
@Index('deals_feed', ['ts'])
export class DealEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 24 })
  market: string;

  @Column({ type: 'varchar', length: 64 })
  collectionShort: string;

  @Column({ type: 'varchar', length: 128 })
  collection: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  model: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  backdrop: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  symbol: string | null;

  @Column({ type: 'int', nullable: true })
  number: number | null;

  @Column({ type: 'double precision' })
  priceTon: number;

  /** Медиана, с которой сравнивали. */
  @Column({ type: 'double precision' })
  medianTon: number;

  /** На сколько процентов ниже медианы. */
  @Column({ type: 'double precision' })
  discountPct: number;

  /** Сколько сделок было в выборке для медианы. */
  @Column({ type: 'int', default: 0 })
  samples: number;

  /** Откуда находка: floor — текущий лот в продаже, sale — прошедшая сделка. */
  @Column({ type: 'varchar', length: 8, default: 'sale' })
  source: string;

  /** Что сравнивали: коллекция целиком, модель или фон. */
  @Column({ type: 'varchar', length: 16, default: 'model' })
  scope: string;

  @Column({ type: 'timestamptz' })
  ts: Date;

  @Column({ type: 'varchar', length: 128, nullable: true })
  giftName: string | null;

  @Column({ type: 'varchar', length: 128 })
  dedupKey: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

@Entity('ton_rates')
export class TonRateEntity {
  /** День в формате YYYY-MM-DD. */
  @PrimaryColumn({ type: 'varchar', length: 10 })
  day: string;

  @Column({ type: 'double precision' })
  priceUsd: number;

  @Column({ type: 'varchar', length: 32, default: 'unknown' })
  source: string;
}

@Entity('settings')
export class SettingEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  key: string;

  @Column({ type: 'jsonb' })
  value: unknown;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

export const ENTITIES = [
  CollectionEntity,
  AttributeEntity,
  TradeEntity,
  ListingEntity,
  FloorEntity,
  DealEntity,
  TonRateEntity,
  SettingEntity,
];

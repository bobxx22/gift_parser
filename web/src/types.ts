export interface BackdropColors {
  center: number;
  edge: number;
  pattern?: number;
  text?: number;
}

export interface Trade {
  id: string;
  market: string;
  kind: string;
  collection: string;
  model: string | null;
  backdrop: string | null;
  symbol: string | null;
  number: number | null;
  priceTon: number;
  priceUsd: number | null;
  stars: number | null;
  starsSell: number | null;
  ts: string;
  giftName: string | null;
  link: string | null;
  image: string | null;
  backdropColors: BackdropColors | null;
}

export interface Stats {
  count: number;
  min: number;
  max: number;
  average: number;
  median: number;
  p25: number;
  p75: number;
  trimmedAverage: number;
  lastPrice: number | null;
  lastTs: string | null;
  avgLast5: number | null;
  volume: number;
  perMarket: Record<string, number>;
}

export interface Floor {
  market: string;
  priceTon: number;
  priceUsd: number | null;
  stars: number | null;
}

export interface OfficialValue {
  currency: string;
  value: number | null;
  floor: number | null;
  average: number | null;
  lastSale: number | null;
  lastSaleDate: string | null;
  listedCount: number | null;
  fragmentListedCount: number | null;
}

export interface GiftLookup {
  slug: string;
  number: number | null;
  collection: string;
  collectionShort: string;
  model: string | null;
  backdrop: string | null;
  symbol: string | null;
  image: string | null;
  backdropColors: BackdropColors | null;
  source: string;
}

export interface Snapshot {
  sessionId: string;
  query: Record<string, unknown>;
  trades: Trade[];
  stats: Stats;
  floors: Floor[];
  /** Активные лоты со всех площадок — то, что можно купить прямо сейчас. */
  listings: Trade[];
  official: OfficialValue | null;
  errors: Record<string, string>;
  finished: boolean;
  /** Площадки, которые прямо сейчас качают данные. */
  loading: string[];
  fromCache: boolean;
}

export interface CollectionItem {
  shortName: string;
  name: string;
  floorPrice: number | null;
  supply: number | null;
  icon: string | null;
  subtitle: string;
}

export interface AttributeItem {
  name: string;
  kind: 'models' | 'backdrops' | 'symbols';
  floorPrice: number | null;
  supply: number | null;
  rarity: number | null;
  image: string | null;
  colors: BackdropColors | null;
  subtitle: string;
}

export interface SourceInfo {
  key: string;
  title: string;
  history: boolean;
  listings: boolean;
  needsLogin: boolean;
  note: string;
}

export interface RatesInfo {
  source: string;
  days: number;
  from: string | null;
  to: string | null;
  min: number | null;
  max: number | null;
  spot: number | null;
  starBuyUsd: number;
  starSellUsd: number;
}

export interface Deal {
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
  /** Опора сравнения: для лота — недавняя цена флора, для сделки — медиана. */
  medianTon: number;
  discountPct: number;
  samples: number;
  /** floor — продаётся прямо сейчас, sale — уже состоявшаяся сделка. */
  source: 'floor' | 'sale' | string;
  /** По чему считали: collection, model или backdrop. */
  scope: string;
  ts: string;
  giftName: string | null;
  link: string | null;
  image: string | null;
}

export interface ScannerStatus {
  enabled: boolean;
  minDiscount: number;
  batchSize: number;
  minSamples: number;
  intervalMs: number;
  markets: string[];
  queueSize: number;
  position: number;
  lastCollection: string | null;
  lastRunAt: string | null;
  scannedCollections: number;
  dealsFound: number;
  running: boolean;
  floorsIntervalMs?: number;
  /** Снимок минимальных цен по всему рынку. */
  floors?: {
    running: boolean;
    intervalMs: number;
    lastRunAt: string | null;
    lastError: string | null;
    collections: number;
    models: number;
    backdrops: number;
    changed: number;
    ms: number;
  };
}

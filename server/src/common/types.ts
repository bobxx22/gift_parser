/** Общие типы: одинаковый вид события для всех площадок. */

export type MarketKey = 'mrkt' | 'portals' | 'fragment' | 'telegram' | 'tonnel';

export type AttributeKind = 'models' | 'backdrops' | 'symbols';

/** Что ищем: коллекция обязательна, остальное — уточнения. */
export interface Filters {
  collection: string;
  model?: string | null;
  backdrop?: string | null;
  symbol?: string | null;
  number?: number | null;
  minPrice?: number | null;
  maxPrice?: number | null;
}

/** Событие рынка, приведённое к общему виду. Цена всегда в TON. */
export interface TradeEvent {
  market: string;
  kind: string;
  collection: string;
  model?: string | null;
  backdrop?: string | null;
  symbol?: string | null;
  number?: number | null;
  priceTon: number;
  ts: Date;
  giftName?: string | null;
  oldPrice?: number | null;
  externalId?: string | null;
  raw?: Record<string, unknown>;
}

/** То же событие для фронта: с пересчётом в доллары и звёзды. */
export interface TradeDto {
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

export interface BackdropColors {
  center: number;
  edge: number;
  pattern?: number;
  text?: number;
}

export interface HistoryOptions {
  onlySales?: boolean;
  pageSize?: number;
}

/** Контракт, который реализует каждая площадка. */
export interface MarketClient {
  readonly key: MarketKey;
  readonly title: string;
  readonly providesHistory: boolean;
  readonly providesListings: boolean;
  readonly needsLogin: boolean;
  readonly note?: string;

  /** Постраничная история: новые сделки идут первыми. */
  historyPages(filters: Filters, options?: HistoryOptions): AsyncGenerator<TradeEvent[]>;

  /** Активные лоты, отсортированные по цене. */
  listings(filters: Filters, limit?: number): Promise<TradeEvent[]>;

  /** Причина, по которой площадка не может обслужить такой фильтр. */
  unsupportedReason?(filters: Filters): string | null;
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

export interface FloorInfo {
  market: string;
  priceTon: number;
  priceUsd: number | null;
  stars: number | null;
}

export interface SearchQuery {
  collection: string;
  model?: string | null;
  backdrop?: string | null;
  symbol?: string | null;
  /** Конкретный экземпляр — когда ищем по ссылке на подарок. */
  number?: number | null;
  sources?: MarketKey[];
  onlySales?: boolean;
  /** Ценовой диапазон в TON: показываем только сделки и лоты внутри него. */
  minPrice?: number | null;
  maxPrice?: number | null;
  /** Сессия, которую надо закрыть: новый поиск отменяет предыдущий. */
  previousSessionId?: string | null;
}

/** Подарок, найденный по ссылке t.me/nft/… */
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

/** lucky_buy сюда не входит: там цена билета розыгрыша, а не цена подарка. */
export const SALE_KINDS = new Set(['sale', 'purchase', 'buy', 'premarket_sale']);

export function isSale(event: { kind: string }): boolean {
  return SALE_KINDS.has(event.kind);
}

/** Цена внутри диапазона; границы включительные и обе необязательные. */
export function inPriceRange(
  range: { minPrice?: number | null; maxPrice?: number | null },
  priceTon: number,
): boolean {
  if (range.minPrice != null && priceTon < range.minPrice) return false;
  if (range.maxPrice != null && priceTon > range.maxPrice) return false;
  return true;
}

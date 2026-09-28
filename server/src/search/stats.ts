/** Статистика по продажам: медиана, перцентили, отсечение выбросов по Тьюки. */

import { Stats, TradeDto } from '../common/types';

export function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.min(low + 1, sorted.length - 1);
  const weight = position - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

export function emptyStats(): Stats {
  return {
    count: 0,
    min: 0,
    max: 0,
    average: 0,
    median: 0,
    p25: 0,
    p75: 0,
    trimmedAverage: 0,
    lastPrice: null,
    lastTs: null,
    avgLast5: null,
    volume: 0,
    perMarket: {},
  };
}

export function computeStats(trades: TradeDto[]): Stats {
  const sales = trades.filter((trade) => trade.kind === 'sale' && trade.priceTon > 0);
  if (!sales.length) return emptyStats();

  const prices = sales.map((trade) => trade.priceTon);
  const sorted = [...prices].sort((a, b) => a - b);
  const p25 = percentile(sorted, 0.25);
  const p75 = percentile(sorted, 0.75);
  const iqr = p75 - p25;
  // Правило Тьюки: отбрасываем случайные проливы и завышенные сделки.
  const core = prices.filter((price) => price >= p25 - 1.5 * iqr && price <= p75 + 1.5 * iqr);
  const kept = core.length ? core : prices;

  const byTime = [...sales].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const lastFive = byTime.slice(0, 5).map((trade) => trade.priceTon);
  const perMarket: Record<string, number> = {};
  for (const trade of sales) perMarket[trade.market] = (perMarket[trade.market] ?? 0) + 1;

  const sum = (values: number[]) => values.reduce((acc, value) => acc + value, 0);
  return {
    count: prices.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    average: sum(prices) / prices.length,
    median: percentile(sorted, 0.5),
    p25,
    p75,
    trimmedAverage: sum(kept) / kept.length,
    lastPrice: byTime[0].priceTon,
    lastTs: byTime[0].ts,
    avgLast5: sum(lastFive) / lastFive.length,
    volume: sum(prices),
    perMarket,
  };
}

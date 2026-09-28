/**
 * Ограничитель запросов на каждую площадку.
 *
 * Площадки параллелим между собой, но внутри одной держим потолок: не больше
 * N одновременных запросов и не чаще, чем раз в M миллисекунд. Так фоновый
 * сканер и обычный поиск делят один канал и не ловят 429.
 */

import { Injectable, Logger } from '@nestjs/common';

export interface RateLimit {
  /** Сколько запросов к площадке может лететь одновременно. */
  concurrency: number;
  /** Минимальная пауза между стартами запросов, мс. */
  interval: number;
}

const DEFAULT_LIMIT: RateLimit = { concurrency: 2, interval: 150 };

/** Подобрано по замерам: Portals и Fragment отвечают тяжелее и злее лимитируют. */
const LIMITS: Record<string, RateLimit> = {
  mrkt: { concurrency: 3, interval: 100 },
  portals: { concurrency: 2, interval: 250 },
  fragment: { concurrency: 2, interval: 300 },
  tonnel: { concurrency: 3, interval: 120 },
  telegram: { concurrency: 1, interval: 250 },
};

interface Lane {
  limit: RateLimit;
  active: number;
  lastStart: number;
  queue: Array<() => void>;
  /** До этого момента площадка «наказана» за 429 — новые запросы ждут. */
  pausedUntil: number;
}

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly lanes = new Map<string, Lane>();

  private lane(key: string): Lane {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = {
        limit: LIMITS[key] ?? DEFAULT_LIMIT,
        active: 0,
        lastStart: 0,
        queue: [],
        pausedUntil: 0,
      };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  /** Притормаживает площадку после 429 или таймаута. */
  penalize(key: string, ms = 3000): void {
    const lane = this.lane(key);
    lane.pausedUntil = Math.max(lane.pausedUntil, Date.now() + ms);
    this.logger.debug(`${key}: пауза ${ms} мс`);
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const lane = this.lane(key);
    await this.acquire(lane);
    try {
      return await task();
    } finally {
      lane.active -= 1;
      this.release(lane);
    }
  }

  private async acquire(lane: Lane): Promise<void> {
    while (true) {
      const now = Date.now();
      const waitForPause = lane.pausedUntil - now;
      const waitForInterval = lane.lastStart + lane.limit.interval - now;
      const free = lane.active < lane.limit.concurrency;
      if (free && waitForPause <= 0 && waitForInterval <= 0) {
        lane.active += 1;
        lane.lastStart = Date.now();
        return;
      }
      if (free && (waitForPause > 0 || waitForInterval > 0)) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(waitForPause, waitForInterval)));
        continue;
      }
      await new Promise<void>((resolve) => lane.queue.push(resolve));
    }
  }

  private release(lane: Lane): void {
    const next = lane.queue.shift();
    if (next) next();
  }

  stats(): Record<string, { active: number; queued: number; pausedMs: number }> {
    const out: Record<string, { active: number; queued: number; pausedMs: number }> = {};
    for (const [key, lane] of this.lanes) {
      out[key] = {
        active: lane.active,
        queued: lane.queue.length,
        pausedMs: Math.max(0, lane.pausedUntil - Date.now()),
      };
    }
    return out;
  }
}

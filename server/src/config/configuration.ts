import { resolve } from 'path';

import { loadProjectEnv } from './load-env';

/** Настройки берём из .env в корне проекта (тот же файл, что читал Python). */
export interface AppConfig {
  port: number;
  projectRoot: string;
  imagesDir: string;
  dataJson: string;
  ratesJson: string;
  backdropsJson: string;
  telegram: { apiId: number; apiHash: string };
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    synchronize: boolean;
  };
  live: { tradesIntervalMs: number; floorsIntervalMs: number; sessionTtlMs: number };
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default (): AppConfig => {
  const projectRoot = resolve(process.env.PROJECT_ROOT ?? resolve(__dirname, '../../..'));
  loadProjectEnv(projectRoot);
  const apiId = envNumber('API_ID', envNumber('TG_API_ID', 0));
  const apiHash = process.env.API_HASH ?? process.env.TG_API_HASH ?? '';
  return {
    port: envNumber('PORT', 3000),
    projectRoot,
    imagesDir: resolve(projectRoot, 'downloaded_collections'),
    dataJson: resolve(projectRoot, 'data.json'),
    ratesJson: resolve(projectRoot, 'ton_usd.json'),
    backdropsJson: resolve(projectRoot, 'legacy-python/gift_parser/backdrops.json'),
    telegram: { apiId, apiHash },
    database: {
      host: process.env.DB_HOST ?? 'localhost',
      port: envNumber('DB_PORT', 5433),
      username: process.env.DB_USER ?? 'gifts',
      password: process.env.DB_PASSWORD ?? 'gifts',
      database: process.env.DB_NAME ?? 'gifts',
      synchronize: (process.env.DB_SYNC ?? 'true') === 'true',
    },
    live: {
      tradesIntervalMs: envNumber('LIVE_TRADES_MS', 20_000),
      floorsIntervalMs: envNumber('LIVE_FLOORS_MS', 60_000),
      sessionTtlMs: envNumber('SESSION_TTL_MS', 30 * 60_000),
    },
  };
};

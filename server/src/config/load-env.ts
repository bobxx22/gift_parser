import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Читает .env вручную: в корне проекта лежит файл в формате `API_ID:12345678`
 * (так его оставила Python-версия), а dotenv понимает только `KEY=VALUE`.
 * Поддерживаем оба разделителя и не перетираем уже заданные переменные.
 */
export function loadEnvFiles(paths: string[]): void {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim().replace(/^export\s+/, '');
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.*)$/);
      if (!match) continue;
      const key = match[1].toUpperCase();
      const value = match[2].trim().replace(/^['"]|['"]$/g, '');
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

/** .env сервера имеет приоритет над общим файлом в корне. */
export function loadProjectEnv(projectRoot: string): void {
  loadEnvFiles([resolve(projectRoot, 'server/.env'), resolve(projectRoot, '.env')]);
}

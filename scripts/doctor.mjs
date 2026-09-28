/**
 * Проверка окружения перед запуском: node, .env, Docker, Postgres, порты, данные.
 *
 *   npm run doctor
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const OK = '[32m✔[0m';
const FAIL = '[31m✖[0m';
const WARN = '[33m![0m';

const problems = [];

function report(ok, title, detail, fix) {
  console.log(`${ok ? OK : FAIL} ${title}${detail ? ` — ${detail}` : ''}`);
  if (!ok && fix) problems.push(fix);
}

function warn(title, detail, fix) {
  console.log(`${WARN} ${title}${detail ? ` — ${detail}` : ''}`);
  if (fix) problems.push(fix);
}

/** Читает .env в формате `KEY=VALUE` и `KEY: VALUE` (так его оставила Python-версия). */
function readEnv(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.*)$/);
    if (match) values[match[1].toUpperCase()] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function portOpen(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolveCheck) => {
    const socket = net.createConnection({ port, host });
    const done = (result) => {
      socket.destroy();
      resolveCheck(result);
    };
    socket.setTimeout(timeout);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

console.log('\nПроверка окружения gift-parser\n');

// 1. Node
const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
report(
  major > 22 || (major === 22 && minor >= 5),
  'Node.js',
  process.version,
  'Обнови Node до 22.5+ (нужен встроенный node:sqlite для переноса сессии Telethon)',
);

// 2. Ключи Telegram
const env = { ...readEnv(resolve(ROOT, '.env')), ...readEnv(resolve(ROOT, 'server/.env')) };
report(
  Boolean(env.API_ID && env.API_HASH),
  'API_ID / API_HASH',
  env.API_ID ? `API_ID=${env.API_ID}` : 'не найдены',
  'Положи API_ID и API_HASH в .env в корне проекта (my.telegram.org → API development tools)',
);

// 3. Зависимости
report(
  existsSync(resolve(ROOT, 'node_modules')) &&
    (existsSync(resolve(ROOT, 'node_modules/@nestjs')) || existsSync(resolve(ROOT, 'server/node_modules/@nestjs'))),
  'npm-зависимости',
  'установлены',
  'Выполни: npm install',
);

// 4. Данные для сида
report(existsSync(resolve(ROOT, 'data.json')), 'data.json', 'каталог подарков на месте', 'Файл data.json потерялся — верни его в корень проекта');
if (!existsSync(resolve(ROOT, 'downloaded_collections'))) {
  warn('downloaded_collections', 'папки нет — картинки будут скачиваться на лету');
}
if (!existsSync(resolve(ROOT, 'tg_session.session'))) {
  warn('tg_session.session', 'нет сессии Telethon — вход через API /api/auth/telegram/start');
}

// 5. Docker
let dockerOk = false;
try {
  await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  dockerOk = true;
  report(true, 'Docker', 'демон отвечает');
} catch {
  report(false, 'Docker', 'демон не отвечает', 'Запусти Docker Desktop и подожди, пока он поднимется, затем: npm run db:up');
}

// 6. Postgres
const dbPort = Number(env.DB_PORT ?? 5433);
const dbUp = await portOpen(dbPort);
report(
  dbUp,
  `PostgreSQL (порт ${dbPort})`,
  dbUp ? 'доступен' : 'не отвечает',
  dockerOk ? 'Подними базу: npm run db:up' : 'Сначала Docker Desktop, потом npm run db:up',
);

if (dbUp && dockerOk) {
  try {
    const { stdout } = await run('docker', [
      'exec', 'gift_parser_db', 'psql', '-U', 'gifts', '-d', 'gifts', '-t', '-c',
      'select (select count(*) from collections) || \' / \' || (select count(*) from ton_rates)',
    ]);
    const [collections, rates] = stdout.trim().split('/').map((value) => Number(value.trim()));
    report(collections > 0, 'Данные в базе', `коллекций ${collections}, дней курса ${rates}`, 'Загрузи данные: npm run seed');
  } catch {
    warn('Данные в базе', 'таблиц ещё нет', 'Загрузи данные: npm run seed');
  }
}

// 7. Порты приложения
for (const [port, name] of [[3000, 'API'], [5173, 'Vite']]) {
  if (await portOpen(port)) warn(`Порт ${port} (${name})`, 'уже занят — возможно, сервер уже запущен');
}

console.log('');
if (problems.length) {
  console.log('Что сделать:');
  problems.forEach((problem, index) => console.log(`  ${index + 1}. ${problem}`));
  console.log('');
  process.exit(1);
}
console.log('Всё готово: npm run dev\n');

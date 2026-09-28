import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import net from 'node:net';
import 'reflect-metadata';

import { AppModule } from './app.module';
import configuration from './config/configuration';

const logger = new Logger('Bootstrap');

/** Проверяем порт до старта Nest — иначе пользователь видит невнятный AggregateError. */
function canConnect(host: string, port: number, timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function ensureDatabase(): Promise<void> {
  const { database } = configuration();
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await canConnect(database.host, database.port)) return;
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  logger.error(`PostgreSQL не отвечает на ${database.host}:${database.port}.`);
  logger.error('Запусти Docker Desktop, затем в корне проекта: npm run db:up');
  logger.error('Если база на другом хосте — пропиши DB_HOST/DB_PORT в .env');
  logger.error('Полная диагностика: npm run doctor');
  process.exit(1);
}

async function bootstrap(): Promise<void> {
  await ensureDatabase();
  const app = await NestFactory.create(AppModule, { cors: true });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  const config = app.get(ConfigService);
  const port = config.get<number>('port') ?? 3000;
  const database = config.get<{ host: string; port: number; database: string }>('database')!;
  await app.listen(port);
  logger.log(`API и WebSocket слушают http://localhost:${port}`);
  logger.log(`Postgres: ${database.host}:${database.port}/${database.database}`);
}

void bootstrap().catch((error: unknown) => {
  const parts = [String((error as Error)?.message ?? '')];
  for (const nested of (error as AggregateError)?.errors ?? []) {
    parts.push(String(nested?.code ?? nested?.message ?? nested));
  }
  const message = parts.filter(Boolean).join(' | ') || String(error);
  logger.error(message);
  logger.error('Диагностика окружения: npm run doctor');
  process.exit(1);
});

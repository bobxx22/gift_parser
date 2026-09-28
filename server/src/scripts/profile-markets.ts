import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { MarketsRegistry } from '../markets/markets.registry';
import { TelegramService } from '../telegram/telegram.service';

/** Замер: сколько времени занимает авторизация и первая страница каждой площадки. */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const telegram = app.get(TelegramService);
  const markets = app.get(MarketsRegistry);
  const filters = { collection: 'Plush Pepe' };

  const t = (start: number) => `${((Date.now() - start) / 1000).toFixed(2)} с`;

  let start = Date.now();
  await telegram.getClient();
  console.log(`getClient: ${t(start)}`);

  start = Date.now();
  await Promise.all([
    telegram.initData('mrkt').then(() => console.log(`  initData mrkt: ${t(start)}`)),
    telegram.initData('portals').then(() => console.log(`  initData portals: ${t(start)}`)),
    telegram.initData('tonnel').then(() => console.log(`  initData tonnel: ${t(start)}`)),
  ]);
  console.log(`initData всех: ${t(start)}`);

  start = Date.now();
  await Promise.all(
    markets.all().map(async (client) => {
      const own = Date.now();
      try {
        if (client.providesHistory) {
          const page = await client.historyPages(filters, { onlySales: true, pageSize: 15 }).next();
          console.log(`  ${client.title} история: ${t(own)} (${page.done ? 0 : page.value.length})`);
        }
      } catch (error) {
        console.log(`  ${client.title} история: ОШИБКА ${t(own)} ${String((error as Error).message).slice(0, 60)}`);
      }
      const lotsStart = Date.now();
      try {
        const lots = await client.listings(filters, 10);
        console.log(`  ${client.title} лоты: ${t(lotsStart)} (${lots.length})`);
      } catch (error) {
        console.log(`  ${client.title} лоты: ОШИБКА ${t(lotsStart)} ${String((error as Error).message).slice(0, 60)}`);
      }
    }),
  );
  console.log(`все площадки параллельно: ${t(start)}`);
  await app.close();
  process.exit(0);
}
void main();

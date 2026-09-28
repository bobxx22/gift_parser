import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { MarketsRegistry } from '../markets/markets.registry';

/** Быстрая проверка каждой площадки: npm run check */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const markets = app.get(MarketsRegistry);
  const filters = { collection: 'Heroic Helmet' };
  for (const client of markets.all()) {
    const line: string[] = [client.title.padEnd(9)];
    try {
      const lots = await client.listings(filters, 3);
      line.push(`лоты: ${lots.length}${lots.length ? ` (флор ${lots[0].priceTon})` : ''}`);
    } catch (error) {
      line.push(`лоты: ОШИБКА ${String((error as Error).message).slice(0, 70)}`);
    }
    if (client.providesHistory) {
      try {
        const page = await client.historyPages(filters, { onlySales: true }).next();
        line.push(`история: ${page.done ? 0 : page.value.length}`);
      } catch (error) {
        line.push(`история: ОШИБКА ${String((error as Error).message).slice(0, 70)}`);
      }
    } else {
      line.push('история: —');
    }
    console.log(line.join(' | '));
  }
  await app.close();
  process.exit(0);
}
void main();

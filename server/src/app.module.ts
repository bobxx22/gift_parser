import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { resolve } from 'path';

import { CatalogModule } from './catalog/catalog.module';
import configuration from './config/configuration';
import { ENTITIES } from './database/entities';
import { GatewayModule } from './gateway/gateway.module';
import { MarketsModule } from './markets/markets.module';
import { RatesModule } from './rates/rates.module';
import { ScannerModule } from './scanner/scanner.module';
import { SearchModule } from './search/search.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      // Ключи Telegram лежат в общем .env в корне проекта — том же, что читал Python.
      envFilePath: [resolve(__dirname, '../.env'), resolve(__dirname, '../../.env'), resolve(__dirname, '../../../.env')],
    }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): TypeOrmModuleOptions => ({
        type: 'postgres',
        ...config.get<Record<string, unknown>>('database')!,
        entities: ENTITIES,
        autoLoadEntities: true,
        logging: ['error'],
        retryAttempts: 2,
        retryDelay: 1500,
      }),
    }),
    GatewayModule,
    TelegramModule,
    MarketsModule,
    RatesModule,
    CatalogModule,
    SearchModule,
    ScannerModule,
  ],
})
export class AppModule {}

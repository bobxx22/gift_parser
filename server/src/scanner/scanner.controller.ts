import { Body, Controller, Get, Post, Query } from '@nestjs/common';

import { FloorsService } from './floors.service';
import { ScannerService, type DealSort, type ScannerSettings } from './scanner.service';

/** Лента выгодных подарков и управление фоновым сканером. */
@Controller('api')
export class ScannerController {
  constructor(
    private readonly scanner: ScannerService,
    private readonly floors: FloorsService,
  ) {}

  /** Снимок минимальных цен по всему рынку: статус и ручное обновление. */
  @Get('floors')
  floorsStatus() {
    return this.floors.status();
  }

  @Post('floors/refresh')
  refreshFloors() {
    return this.floors.refresh();
  }

  /** Пересобрать ленту по текущему снимку, не дожидаясь тика. */
  @Post('floors/scan')
  scanFloors() {
    return this.scanner.scanFloors();
  }

  @Get('deals')
  list(
    @Query('minDiscount') minDiscount?: string,
    @Query('hours') hours?: string,
    @Query('limit') limit?: string,
    @Query('markets') markets?: string,
    @Query('sort') sort?: DealSort,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
  ) {
    return this.scanner.list({
      minDiscount: minDiscount ? Number(minDiscount) : undefined,
      hours: hours ? Number(hours) : undefined,
      limit: limit ? Number(limit) : undefined,
      markets: markets ? markets.split(',').filter(Boolean) : undefined,
      sort: sort === 'discount' ? 'discount' : 'time',
      minPrice: minPrice ? Number(minPrice) : undefined,
      maxPrice: maxPrice ? Number(maxPrice) : undefined,
    });
  }

  @Get('scanner')
  status() {
    return this.scanner.status();
  }

  @Post('scanner')
  update(@Body() body: Partial<ScannerSettings>) {
    return this.scanner.updateSettings(body ?? {});
  }

  /** Проверить конкретную коллекцию прямо сейчас. */
  @Post('scanner/scan')
  scan(@Body() body: { collection: string }) {
    return this.scanner.scanByName(String(body?.collection ?? ''));
  }
}

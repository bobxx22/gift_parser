import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';

import { SearchQuery } from '../common/types';
import { MarketsRegistry } from '../markets/markets.registry';
import { SearchService } from './search.service';

@Controller('api')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly markets: MarketsRegistry,
  ) {}

  @Get('sources')
  sources() {
    return this.markets.info();
  }

  @Post('search')
  create(@Body() body: SearchQuery) {
    return this.search.create(body);
  }

  @Post('search/:id/more')
  async more(@Param('id') id: string) {
    const trades = await this.search.loadMore(id);
    return { trades, snapshot: this.search.snapshot(this.search.get(id)) };
  }

  @Post('search/:id/refresh')
  async refresh(@Param('id') id: string) {
    const session = this.search.get(id);
    const trades = await this.search.refreshNew(session);
    return { trades, snapshot: this.search.snapshot(session) };
  }

  @Get('search/:id')
  snapshot(@Param('id') id: string) {
    return this.search.snapshot(this.search.get(id));
  }

  /** Останавливает поиск: старая сессия больше не качает и не шлёт события. */
  @Delete('search/:id')
  close(@Param('id') id: string) {
    this.search.close(id);
    return { ok: true };
  }
}

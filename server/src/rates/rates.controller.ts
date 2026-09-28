import { Controller, Get, Post } from '@nestjs/common';

import { RatesService } from './rates.service';

@Controller('api/rates')
export class RatesController {
  constructor(private readonly rates: RatesService) {}

  @Get()
  async summary() {
    await this.rates.spot();
    return this.rates.summary();
  }

  @Post('refresh')
  async refresh() {
    const added = await this.rates.refresh(true);
    return { added, ...this.rates.summary() };
  }
}

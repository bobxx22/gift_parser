import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TonRateEntity } from '../database/entities';
import { RatesController } from './rates.controller';
import { RatesService } from './rates.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([TonRateEntity])],
  controllers: [RatesController],
  providers: [RatesService],
  exports: [RatesService],
})
export class RatesModule {}

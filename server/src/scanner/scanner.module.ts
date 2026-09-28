import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CollectionEntity, DealEntity, FloorEntity, TradeEntity } from '../database/entities';
import { FloorsService } from './floors.service';
import { ScannerController } from './scanner.controller';
import { ScannerService } from './scanner.service';

@Module({
  imports: [TypeOrmModule.forFeature([CollectionEntity, TradeEntity, DealEntity, FloorEntity])],
  controllers: [ScannerController],
  providers: [ScannerService, FloorsService],
  exports: [ScannerService, FloorsService],
})
export class ScannerModule {}

import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AttributeEntity, CollectionEntity } from '../database/entities';
import { CatalogController, GiftController, ImagesController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { GiftLookupService } from './gift-lookup.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([CollectionEntity, AttributeEntity])],
  controllers: [CatalogController, GiftController, ImagesController],
  providers: [CatalogService, GiftLookupService],
  exports: [CatalogService, GiftLookupService],
})
export class CatalogModule {}

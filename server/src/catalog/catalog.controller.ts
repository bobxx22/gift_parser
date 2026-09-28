import { Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import { AttributeKind } from '../common/types';
import { CatalogService } from './catalog.service';
import { GiftLookupService } from './gift-lookup.service';

@Controller('api/catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('collections')
  collections(@Query('q') query = '', @Query('limit') limit = '60') {
    return this.catalog.collections(query, Number(limit) || 60);
  }

  @Get('attributes')
  attributes(
    @Query('collection') collection: string,
    @Query('kind') kind: AttributeKind = 'models',
    @Query('q') query = '',
    @Query('limit') limit = '80',
  ) {
    return this.catalog.attributes(collection, kind, query, Number(limit) || 80);
  }

  @Post('refresh')
  refresh() {
    return this.catalog.refresh();
  }

  @Post('backdrop-colors/:collection')
  colors(@Param('collection') collection: string) {
    return this.catalog.refreshBackdropColors(collection).then((updated) => ({ updated }));
  }
}

/** Подарок по ссылке t.me/nft/… — его модель, фон и символ. */
@Controller('api/gift')
export class GiftController {
  constructor(private readonly lookup: GiftLookupService) {}

  @Get()
  find(@Query('url') url: string) {
    return this.lookup.lookup(url);
  }
}

/** Отдаёт картинки моделей: локальные из downloaded_collections, недостающие докачивает. */
@Controller('images')
export class ImagesController {
  constructor(private readonly catalog: CatalogService) {}

  @Get(':short/:file')
  async image(
    @Param('short') short: string,
    @Param('file') file: string,
    @Query('kind') kind = 'models',
    @Res() response: Response,
  ) {
    const name = decodeURIComponent(file).replace(/\.png$/i, '');
    const path =
      name === '__icon__'
        ? await this.catalog.iconFile(short)
        : await this.catalog.imageFile(short, name, kind);
    if (!path) {
      response.status(404).json({ message: 'нет картинки' });
      return;
    }
    response.setHeader('Cache-Control', 'public, max-age=86400');
    response.sendFile(path);
  }
}

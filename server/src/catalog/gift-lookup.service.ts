/**
 * Поиск подарка по ссылке: t.me/nft/HeroicHelmet-1349, fragment.com/gift/…
 * или просто «HeroicHelmet-1349».
 *
 * Атрибуты берём из официального API Telegram (payments.getUniqueStarGift),
 * а если входа нет — со страницы подарка на Fragment.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { BackdropColors, GiftLookup } from '../common/types';
import { pascalName, slugify } from '../common/utils';
import { FragmentService } from '../markets/fragment.service';
import { TelegramMarketService } from '../markets/telegram-market.service';
import { CatalogService } from './catalog.service';

const SLUG_RE = /([A-Za-z0-9'’_%-]+?)-(\d+)\s*$/;

@Injectable()
export class GiftLookupService {
  private readonly logger = new Logger(GiftLookupService.name);

  constructor(
    private readonly catalog: CatalogService,
    private readonly telegramMarket: TelegramMarketService,
    private readonly fragment: FragmentService,
  ) {}

  /** Достаёт из ссылки имя коллекции и номер экземпляра. */
  parse(input: string): { collectionSlug: string; number: number } | null {
    const raw = String(input ?? '').trim();
    if (!raw) return null;
    let tail = raw;
    try {
      const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      const parts = url.pathname.split('/').filter(Boolean);
      tail = parts.at(-1) ?? raw;
    } catch {
      tail = raw.split('/').filter(Boolean).at(-1) ?? raw;
    }
    const match = SLUG_RE.exec(decodeURIComponent(tail));
    if (!match) return null;
    return { collectionSlug: slugify(match[1]), number: Number(match[2]) };
  }

  async lookup(input: string): Promise<GiftLookup> {
    const parsed = this.parse(input);
    if (!parsed) {
      throw new NotFoundException(
        'Не разобрал ссылку. Нужен вид https://t.me/nft/HeroicHelmet-1349',
      );
    }
    const collection = await this.catalog.resolve(parsed.collectionSlug);
    if (!collection) {
      throw new NotFoundException(`Коллекция «${parsed.collectionSlug}» не найдена в каталоге`);
    }

    const slug = `${pascalName(collection.name)}-${parsed.number}`;
    let model: string | null = null;
    let backdrop: string | null = null;
    let symbol: string | null = null;
    let colors: BackdropColors | null = null;
    let source = '';

    try {
      const gift = await this.telegramMarket.uniqueGift(slug);
      if (gift) {
        ({ model, backdrop, symbol, colors } = gift);
        source = 'telegram';
      }
    } catch (error) {
      this.logger.debug(`Telegram по ${slug}: ${String((error as Error).message)}`);
    }

    if (!model && !backdrop && !symbol) {
      try {
        const attributes = await this.fragment.giftAttributes(slug);
        if (attributes) {
          model = attributes.model;
          backdrop = attributes.backdrop;
          symbol = attributes.symbol;
          source = 'fragment';
        }
      } catch (error) {
        this.logger.debug(`Fragment по ${slug}: ${String((error as Error).message)}`);
      }
    }

    if (!model && !backdrop && !symbol) {
      throw new NotFoundException(
        `Не удалось получить атрибуты ${slug}. Проверь ссылку или войди в Telegram.`,
      );
    }

    if (!colors && backdrop) colors = await this.catalog.colorsFor(collection.name, backdrop);

    return {
      slug,
      number: parsed.number,
      collection: collection.name,
      collectionShort: collection.shortName,
      model,
      backdrop,
      symbol,
      image: model
        ? `/images/${collection.shortName}/${encodeURIComponent(model)}.png`
        : null,
      backdropColors: colors,
      source,
    };
  }
}

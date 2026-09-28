import { useCallback, useEffect, useState } from 'react';

import { api } from '../api';
import { PriceRange, toPrice } from './PriceRange';
import { getSocket } from '../socket';
import type { Deal, ScannerStatus, SourceInfo } from '../types';

interface Props {
  sources: SourceInfo[];
  onPick: (deal: Deal) => void;
}

type Sort = 'time' | 'discount';

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

/**
 * Лента выгодных: фоновый сканер обходит коллекции и складывает сюда сделки
 * заметно ниже медианы. Можно ограничить площадки (это же ограничение уходит
 * и в сам сканер) и сортировать по времени или по выгоде.
 */
export function DealsPanel({ sources, onPick }: Props) {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [status, setStatus] = useState<ScannerStatus | null>(null);
  const [minDiscount, setMinDiscount] = useState(10);
  const [sort, setSort] = useState<Sort>('time');
  const [markets, setMarkets] = useState<string[]>([]);
  const [price, setPrice] = useState({ min: '', max: '' });
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  const minPrice = toPrice(price.min);
  const maxPrice = toPrice(price.max);

  const reload = useCallback(() => {
    api
      .deals({ minDiscount, hours: 48, markets, sort, minPrice, maxPrice })
      .then(setDeals)
      .catch(() => undefined);
    api.scanner().then(setStatus).catch(() => undefined);
  }, [minDiscount, markets, sort, minPrice, maxPrice]);

  useEffect(() => {
    reload();
    const timer = setInterval(reload, 30_000);
    return () => clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    const socket = getSocket();
    const onDeals = ({ deals: incoming }: { deals: Deal[] }) => {
      const matching = incoming.filter(
        (deal) =>
          deal.discountPct >= minDiscount &&
          (!markets.length || markets.includes(deal.market.toLowerCase())) &&
          (minPrice == null || deal.priceTon >= minPrice) &&
          (maxPrice == null || deal.priceTon <= maxPrice),
      );
      if (!matching.length) return;
      setDeals((current) => {
        const known = new Set(current.map((deal) => deal.id));
        const added = matching.filter((deal) => !known.has(deal.id));
        if (!added.length) return current;
        setFresh((old) => new Set([...old, ...added.map((deal) => deal.id)]));
        setTimeout(() => setFresh(new Set()), 6000);
        const next = [...added, ...current];
        if (sort === 'discount') next.sort((a, b) => b.discountPct - a.discountPct);
        return next.slice(0, 80);
      });
    };
    socket.on('deals:new', onDeals);
    return () => {
      socket.off('deals:new', onDeals);
    };
  }, [minDiscount, markets, sort, minPrice, maxPrice]);

  const applyDiscount = (value: number) => {
    setMinDiscount(value);
    api.scannerUpdate({ minDiscount: value }).catch(() => undefined);
  };

  const historyMarkets = sources.filter((source) => source.history).map((source) => source.key);

  /**
   * Пустой список = включены все. Первый клик по чипу выключает именно его,
   * дальше чипы работают как обычные галочки; когда выключили всё — снова все.
   */
  const toggleMarket = (key: string) => {
    const current = markets.length ? markets : historyMarkets;
    const next = current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key];
    const value = next.length === 0 || next.length === historyMarkets.length ? [] : next;
    setMarkets(value);
    // Тот же набор уходит в сканер: пустой список = обходить все площадки.
    api.scannerUpdate({ markets: value }).catch(() => undefined);
  };

  return (
    <aside className="deals">
      <div className="deals__head">
        <div className="sidebar__title">Выгодные</div>
        <label className="deals__threshold">
          ниже медианы на
          <input
            type="number"
            min={1}
            max={90}
            value={minDiscount}
            onChange={(event) => applyDiscount(Number(event.target.value) || 1)}
          />
          %
        </label>
      </div>

      <PriceRange min={price.min} max={price.max} onChange={setPrice} />

      <div className="deals__filters">
        {sources
          .filter((source) => source.history)
          .map((source) => (
            <button
              key={source.key}
              className={`chip chip--toggle ${markets.length === 0 || markets.includes(source.key) ? 'chip--on' : ''}`}
              onClick={() => toggleMarket(source.key)}
              title="Фильтр ленты и площадок для фонового сканера"
            >
              {source.title}
            </button>
          ))}
      </div>

      <div className="deals__sort">
        <button
          className={`chip chip--toggle ${sort === 'time' ? 'chip--on' : ''}`}
          onClick={() => setSort('time')}
        >
          по времени
        </button>
        <button
          className={`chip chip--toggle ${sort === 'discount' ? 'chip--on' : ''}`}
          onClick={() => setSort('discount')}
        >
          по выгоде
        </button>
      </div>

      <div className="deals__status">
        {status ? (
          <>
            {status.floors ? (
              <>
                снимок цен: {status.floors.collections} коллекций, {status.floors.models} моделей,{' '}
                {status.floors.backdrops} фонов
                {status.floors.lastRunAt ? ` · ${ago(status.floors.lastRunAt)}` : ''}
                <br />
              </>
            ) : null}
            история: {status.lastCollection ?? '…'} · {status.scannedCollections} коллекций ·
            найдено {status.dealsFound}
          </>
        ) : (
          'сканер запускается…'
        )}
      </div>

      <div className="deals__list">
        {deals.length === 0 ? (
          <div className="deals__empty">
            {minPrice || maxPrice
              ? 'В этом диапазоне цен находок пока нет — сканер идёт по коллекциям дальше.'
              : 'Пока пусто. Сканер обходит коллекции по кругу и добавляет сюда сделки ниже медианы.'}
          </div>
        ) : null}
        {deals.map((deal) => (
          <button
            key={deal.id}
            className={`deal ${fresh.has(deal.id) ? 'deal--fresh' : ''}`}
            onClick={() => onPick(deal)}
            title="Открыть в основном поиске"
          >
            <div className="deal__image">
              {deal.image ? <img src={deal.image} alt="" loading="lazy" /> : null}
            </div>
            <div className="deal__body">
              <div className="deal__title">
                {deal.collection}
                {deal.number ? <span className="muted"> #{deal.number}</span> : null}
              </div>
              <div className="deal__model">{deal.model ?? 'модель не указана'}</div>
              <div className="deal__price">
                <b>{deal.priceTon.toLocaleString('ru-RU')} TON</b>
                <span className="muted">
                  {deal.source === 'floor' ? ' было ' : ' из '}
                  {deal.medianTon.toLocaleString('ru-RU')}
                </span>
                {deal.stars ? <span className="stars"> {deal.stars.toLocaleString('ru-RU')} ★</span> : null}
              </div>
              <div className="deal__meta">
                <span className={`market market--${deal.market.toLowerCase()}`}>{deal.market}</span>
                <span className={`badge badge--${deal.source}`}>
                  {deal.source === 'floor' ? 'в продаже' : 'продано'}
                </span>
                <span className="muted">
                  {ago(deal.ts)}
                  {deal.samples ? ` · выборка ${deal.samples}` : ''}
                </span>
              </div>
            </div>
            <div className="deal__discount">−{Math.round(deal.discountPct)}%</div>
          </button>
        ))}
      </div>
    </aside>
  );
}

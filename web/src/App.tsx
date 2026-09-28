import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from './api';
import { DealsPanel } from './components/DealsPanel';
import { GiftPicker, gradient, type PickerOption } from './components/GiftPicker';
import { ListingsTable } from './components/ListingsTable';
import { PriceChart } from './components/PriceChart';
import { PriceRange, toPrice } from './components/PriceRange';
import { StatCards } from './components/StatCards';
import { TradesTable } from './components/TradesTable';
import { getSocket } from './socket';
import type { Deal, GiftLookup, RatesInfo, Snapshot, SourceInfo, Trade } from './types';

const EMPTY_STATS = {
  count: 0, min: 0, max: 0, average: 0, median: 0, p25: 0, p75: 0,
  trimmedAverage: 0, lastPrice: null, lastTs: null, avgLast5: null, volume: 0, perMarket: {},
};

/** Подпись активного диапазона: «от 70 TON», «до 90 TON» или «70–90 TON». */
function priceLabel(min: number | null, max: number | null): string | null {
  if (min && max) return `${min}–${max} TON`;
  if (min) return `от ${min} TON`;
  if (max) return `до ${max} TON`;
  return null;
}

/** По умолчанию точной копией считаем совпадение по модели и фону. */
const DEFAULT_MATCH = { model: true, backdrop: true, symbol: false };

export default function App() {
  const [auth, setAuth] = useState<{ authorized: boolean; user: string | null }>({ authorized: false, user: null });
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [rates, setRates] = useState<RatesInfo | null>(null);

  const [collection, setCollection] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [backdrop, setBackdrop] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [price, setPrice] = useState({ min: '', max: '' });
  const [tab, setTab] = useState<'trades' | 'listings'>('trades');
  const [live, setLive] = useState(true);

  const [giftUrl, setGiftUrl] = useState('');
  const [match, setMatch] = useState(DEFAULT_MATCH);
  const [gift, setGift] = useState<GiftLookup | null>(null);
  /** Номер экземпляра, который подсвечиваем в таблице и на графике. */
  const [highlight, setHighlight] = useState<number | null>(null);

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [status, setStatus] = useState('Выбери подарок или вставь ссылку');
  const [loading, setLoading] = useState(false);
  const sessionRef = useRef<string | null>(null);

  // -------------------------------------------------------------- загрузка
  useEffect(() => {
    api.authStatus().then(setAuth).catch(() => undefined);
    api.rates().then(setRates).catch(() => undefined);
    api
      .sources()
      .then((items) => {
        setSources(items);
        setEnabled(Object.fromEntries(items.map((item) => [item.key, true])));
      })
      .catch(() => undefined);
  }, []);

  // ------------------------------------------------------------ WebSocket
  useEffect(() => {
    const socket = getSocket();
    const onConnect = () => {
      // Сервер мог перезапуститься — после реконнекта подписываемся заново.
      if (sessionRef.current) socket.emit('search:subscribe', { sessionId: sessionRef.current });
    };
    /** События старой сессии игнорируем — иначе новый поиск смешается с прошлым. */
    const isStale = (next: Snapshot) => next.sessionId !== sessionRef.current;

    const onTrades = ({ trades: fresh, snapshot: next, market }: { trades: Trade[]; snapshot: Snapshot; market?: string }) => {
      if (isStale(next)) return;
      if (!live && trades.length) {
        setStatus(`Есть ${fresh.length} новых сделок (обновление выключено)`);
        return;
      }
      setSnapshot(next);
      setTrades(next.trades);
      if (fresh.length) {
        setStatus(`${market ?? 'Готово'}: +${fresh.length} сделок (всего ${next.trades.length})`);
      }
    };
    const onFloors = ({ snapshot: next }: { snapshot: Snapshot }) => {
      if (isStale(next)) return;
      setSnapshot(next);
      setTrades(next.trades);
    };
    const onProgress = ({ text }: { text: string }) => setStatus(text);
    const onDone = ({ snapshot: next }: { snapshot: Snapshot }) => {
      if (isStale(next)) return;
      setSnapshot(next);
      setTrades(next.trades);
      setStatus(`Загружено ${next.trades.length} сделок`);
    };

    socket.on('connect', onConnect);
    socket.on('trades:new', onTrades);
    socket.on('floors:update', onFloors);
    socket.on('search:progress', onProgress);
    socket.on('search:done', onDone);
    return () => {
      socket.off('connect', onConnect);
      socket.off('trades:new', onTrades);
      socket.off('floors:update', onFloors);
      socket.off('search:progress', onProgress);
      socket.off('search:done', onDone);
    };
  }, [live, trades.length]);

  // -------------------------------------------------------------- действия
  const loadCollections = useCallback(async (query: string): Promise<PickerOption[]> => {
    const items = await api.collections(query);
    return items.map((item) => ({
      value: item.name,
      label: item.name,
      subtitle: item.subtitle,
      image: item.icon,
      colors: null,
    }));
  }, []);

  const loadAttributes = useCallback(
    (kind: 'models' | 'backdrops' | 'symbols') => async (query: string): Promise<PickerOption[]> => {
      if (!collection) return [];
      const items = await api.attributes(collection, kind, query);
      return items.map((item) => ({
        value: item.name,
        label: item.name,
        subtitle: item.subtitle,
        image: item.image,
        colors: item.colors,
      }));
    },
    [collection],
  );

  const runSearch = async (params: {
    collection: string;
    model: string | null;
    backdrop: string | null;
    symbol: string | null;
    /** Диапазон цены; не передан — берём то, что сейчас в полях. */
    range?: { min: number | null; max: number | null };
    silent?: boolean;
  }) => {
    const bounds = params.range ?? { min: toPrice(price.min), max: toPrice(price.max) };
    const previous = sessionRef.current;
    // Отписываемся и гасим прошлую сессию до старта новой.
    if (previous) {
      getSocket().emit('search:unsubscribe', { sessionId: previous });
      sessionRef.current = null;
    }
    setLoading(true);
    if (!params.silent) {
      setStatus('Ищу…');
      setTrades([]);
      setSnapshot(null);
    }
    try {
      const result = await api.search({
        collection: params.collection,
        model: params.model,
        backdrop: params.backdrop,
        symbol: params.symbol,
        minPrice: bounds.min,
        maxPrice: bounds.max,
        onlySales: true,
        previousSessionId: previous,
        sources: Object.entries(enabled).filter(([, on]) => on).map(([key]) => key),
      });
      sessionRef.current = result.sessionId;
      getSocket().emit('search:subscribe', { sessionId: result.sessionId });
      setSnapshot(result);
      setTrades(result.trades);
      setStatus(
        result.trades.length
          ? `Из базы: ${result.trades.length} сделок, качаю свежие…`
          : 'Качаю со всех площадок…',
      );
    } catch (error) {
      setStatus(`Ошибка: ${String((error as Error).message)}`);
    } finally {
      setLoading(false);
    }
  };

  const search = () => {
    if (!collection) {
      setStatus('Сначала выбери коллекцию или вставь ссылку');
      return;
    }
    setGift(null);
    setHighlight(null);
    void runSearch({ collection, model, backdrop, symbol });
  };

  /** Клик по выгодной сделке — открываем её в обычном поиске. */
  const openDeal = (deal: Deal) => {
    setGift(null);
    setCollection(deal.collection);
    setModel(deal.model);
    setBackdrop(null);
    setSymbol(null);
    setHighlight(deal.number ?? null);
    void runSearch({ collection: deal.collection, model: deal.model, backdrop: null, symbol: null });
  };

  /** Поиск точных копий подарка по ссылке t.me/nft/… */
  const searchByUrl = async () => {
    const url = giftUrl.trim();
    if (!url) return;
    setLoading(true);
    setStatus('Разбираю ссылку…');
    try {
      const found = await api.gift(url);
      setGift(found);
      setHighlight(found.number);
      setCollection(found.collection);
      const next = {
        model: match.model ? found.model : null,
        backdrop: match.backdrop ? found.backdrop : null,
        symbol: match.symbol ? found.symbol : null,
      };
      setModel(next.model);
      setBackdrop(next.backdrop);
      setSymbol(next.symbol);
      await runSearch({ collection: found.collection, ...next });
    } catch (error) {
      setStatus(`Ошибка: ${String((error as Error).message)}`);
      setLoading(false);
    }
  };

  const loadMore = async () => {
    const sessionId = sessionRef.current;
    if (!sessionId || loading) return;
    setLoading(true);
    try {
      const result = await api.loadMore(sessionId);
      if (result.snapshot.sessionId !== sessionRef.current) return;
      setSnapshot(result.snapshot);
      setTrades(result.snapshot.trades);
      setStatus(result.trades.length ? `Добавилось ${result.trades.length} сделок` : 'Больше сделок нет');
    } catch (error) {
      const message = String((error as Error).message);
      if (message.includes('404') && collection) {
        setStatus('Сессия устарела, обновляю…');
        setLoading(false);
        await runSearch({ collection, model, backdrop, symbol, silent: true });
        return;
      }
      setStatus(`Ошибка: ${message}`);
    } finally {
      setLoading(false);
    }
  };

  const stats = snapshot?.stats ?? EMPTY_STATS;
  const floors = snapshot?.floors ?? [];
  const listings = snapshot?.listings ?? [];
  const range = priceLabel(toPrice(price.min), toPrice(price.max));
  const clearRange = () => {
    setPrice({ min: '', max: '' });
    if (collection) {
      void runSearch({ collection, model, backdrop, symbol, range: { min: null, max: null } });
    }
  };
  const busyMarkets = snapshot?.loading ?? [];
  const errors = useMemo(() => Object.entries(snapshot?.errors ?? {}), [snapshot]);

  return (
    <div className="app">
      <header className="header">
        <h1>Цены подарков Telegram</h1>
        <div className={`auth ${auth.authorized ? 'auth--ok' : 'auth--bad'}`}>
          {auth.authorized ? `Telegram: ${auth.user}` : 'Telegram: нет входа'}
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar__title">Подарок</div>
          <GiftPicker
            title="Коллекция"
            value={collection}
            load={loadCollections}
            onChange={(value) => {
              setCollection(value);
              setModel(null);
              setBackdrop(null);
              setSymbol(null);
              setGift(null);
              setHighlight(null);
            }}
          />
          <GiftPicker title="Модель" value={model} allowAny disabled={!collection}
            load={loadAttributes('models')} onChange={setModel} />
          <GiftPicker title="Фон" value={backdrop} allowAny disabled={!collection}
            load={loadAttributes('backdrops')} onChange={setBackdrop} />
          <GiftPicker title="Символ" value={symbol} allowAny disabled={!collection}
            load={loadAttributes('symbols')} onChange={setSymbol} />

          <div className="sidebar__title">Цена</div>
          <PriceRange min={price.min} max={price.max} onChange={setPrice} onSubmit={search} />
          <div className="muted small">
            Пусто — без ограничений. Диапазон применяется и к сделкам, и к лотам в продаже.
          </div>

          <button className="button button--accent" onClick={search} disabled={loading}>
            {loading ? 'Ищу…' : 'Искать'}
          </button>

          <div className="sidebar__title">Поиск по ссылке</div>
          <input
            className="picker__input"
            placeholder="https://t.me/nft/HeroicHelmet-1349"
            value={giftUrl}
            onChange={(event) => setGiftUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void searchByUrl();
            }}
          />
          <div className="muted small">Точная копия по:</div>
          <div className="match">
            {([['model', 'модели'], ['backdrop', 'фону'], ['symbol', 'символу']] as const).map(
              ([key, label]) => (
                <label className="check" key={key}>
                  <input
                    type="checkbox"
                    checked={match[key]}
                    onChange={(event) => setMatch((current) => ({ ...current, [key]: event.target.checked }))}
                  />
                  {label}
                </label>
              ),
            )}
          </div>
          <button className="button" onClick={() => void searchByUrl()} disabled={loading || !giftUrl.trim()}>
            Найти по ссылке
          </button>

          {gift ? (
            <div className="gift-card">
              <div className="gift-card__image" style={{ background: gradient(gift.backdropColors) }}>
                {gift.image ? <img src={gift.image} alt="" /> : null}
              </div>
              <div>
                <div className="gift-card__title">{gift.slug}</div>
                <div className="muted small">{gift.model ?? '—'}</div>
                <div className="muted small">{gift.backdrop ?? '—'} · {gift.symbol ?? '—'}</div>
              </div>
            </div>
          ) : null}

          <div className="sidebar__title">Площадки</div>
          {sources.map((source) => (
            <label className="check" key={source.key} title={source.note}>
              <input
                type="checkbox"
                checked={Boolean(enabled[source.key])}
                onChange={(event) => setEnabled((current) => ({ ...current, [source.key]: event.target.checked }))}
              />
              {source.title}
              {!source.history ? <span className="muted"> (лоты)</span> : null}
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />
            Обновлять в реальном времени
          </label>

          <div className="status">{status}</div>
          {busyMarkets.length ? (
            <div className="chips">
              {busyMarkets.map((marketName) => (
                <span className="chip" key={marketName}>{marketName}…</span>
              ))}
            </div>
          ) : null}
          {errors.length ? (
            <div className="errors">
              {errors.map(([name, message]) => (
                <div key={name} className="errors__row">
                  <b>{name}:</b> {message}
                </div>
              ))}
            </div>
          ) : null}
        </aside>

        <main className="content">
          <StatCards stats={stats} floors={floors} official={snapshot?.official ?? null} rates={rates} />
          <PriceChart trades={trades} stats={stats} floors={floors} highlight={highlight} />

          {range ? (
            <div className="range-note">
              Фильтр цены: {range}. Статистика и график считаются только по сделкам внутри
              диапазона.
              <button className="range-note__clear" onClick={clearRange}>сбросить</button>
            </div>
          ) : null}

          <div className="tabs">
            <button
              className={`tab ${tab === 'trades' ? 'tab--on' : ''}`}
              onClick={() => setTab('trades')}
            >
              Сделки {trades.length ? <span className="muted">({trades.length})</span> : null}
            </button>
            <button
              className={`tab ${tab === 'listings' ? 'tab--on' : ''}`}
              onClick={() => setTab('listings')}
            >
              В продаже {listings.length ? <span className="muted">({listings.length})</span> : null}
            </button>
          </div>

          {tab === 'trades' ? (
            <TradesTable
              trades={trades}
              loading={loading}
              finished={Boolean(snapshot?.finished)}
              highlight={highlight}
              onLoadMore={loadMore}
            />
          ) : (
            <ListingsTable listings={listings} highlight={highlight} />
          )}
        </main>

        <DealsPanel sources={sources} onPick={openDeal} />
      </div>
    </div>
  );
}

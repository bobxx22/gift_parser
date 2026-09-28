import { useMemo, useRef, useState } from 'react';

import type { Trade } from '../types';

type SortKey = 'ts' | 'market' | 'model' | 'backdrop' | 'symbol' | 'number' | 'priceTon';

interface Props {
  trades: Trade[];
  loading: boolean;
  finished: boolean;
  /** Номер экземпляра, который искали по ссылке — его строки обводим белым. */
  highlight?: number | null;
  onLoadMore: () => void;
}

const COLUMNS: Array<{ key: SortKey; title: string; align?: 'right' }> = [
  { key: 'ts', title: 'Дата (UTC)' },
  { key: 'market', title: 'Площадка' },
  { key: 'model', title: 'Модель' },
  { key: 'backdrop', title: 'Фон' },
  { key: 'symbol', title: 'Символ' },
  { key: 'number', title: '№', align: 'right' },
  { key: 'priceTon', title: 'Цена, TON', align: 'right' },
];

/** Таблица сделок: сортировка по клику и подгрузка при прокрутке вниз. */
export function TradesTable({ trades, loading, finished, highlight, onLoadMore }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'ts', desc: true });
  const guard = useRef(0);

  const rows = useMemo(() => {
    const copy = [...trades];
    copy.sort((a, b) => {
      const left = sort.key === 'ts' ? Date.parse(a.ts) : (a[sort.key] ?? '');
      const right = sort.key === 'ts' ? Date.parse(b.ts) : (b[sort.key] ?? '');
      if (typeof left === 'number' && typeof right === 'number') {
        return sort.desc ? right - left : left - right;
      }
      return sort.desc
        ? String(right).localeCompare(String(left))
        : String(left).localeCompare(String(right));
    });
    return copy;
  }, [trades, sort]);

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (bottom < 240 && !loading && !finished && Date.now() - guard.current > 800) {
      guard.current = Date.now();
      onLoadMore();
    }
  };

  return (
    <div className="table" onScroll={onScroll}>
      <table>
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                className={column.align === 'right' ? 'right' : undefined}
                onClick={() =>
                  setSort((current) =>
                    current.key === column.key
                      ? { key: column.key, desc: !current.desc }
                      : { key: column.key, desc: true },
                  )
                }
              >
                {column.title}
                {sort.key === column.key ? (sort.desc ? ' ↓' : ' ↑') : ''}
              </th>
            ))}
            <th className="right">Цена, $</th>
            <th className="right stars">Цена, ★</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((trade) => (
            <tr
              key={trade.id}
              className={highlight != null && trade.number === highlight ? 'row--highlight' : undefined}
              onDoubleClick={() => trade.link && window.open(trade.link, '_blank')}
              title={trade.link ?? undefined}
            >
              <td>{new Date(trade.ts).toISOString().slice(0, 16).replace('T', ' ')}</td>
              <td className={`market market--${trade.market.toLowerCase()}`}>{trade.market}</td>
              <td>{trade.model ?? ''}</td>
              <td>{trade.backdrop ?? ''}</td>
              <td>{trade.symbol ?? ''}</td>
              <td className="right">{trade.number ?? ''}</td>
              <td className="right">{trade.priceTon.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              <td className="right">{trade.priceUsd !== null ? `$${trade.priceUsd.toLocaleString('ru-RU')}` : ''}</td>
              <td className="right stars">{trade.stars !== null ? `${trade.stars.toLocaleString('ru-RU')} ★` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="table__footer">
        {loading ? 'Подгружаю…' : finished ? 'Вся история загружена' : 'Прокрути вниз — подгружу ещё'}
      </div>
    </div>
  );
}

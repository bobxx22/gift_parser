import type { Trade } from '../types';

interface Props {
  listings: Trade[];
  /** Номер экземпляра, найденного по ссылке — обводим белым, как в сделках. */
  highlight?: number | null;
}

/**
 * Активные лоты со всех площадок: то, что прямо сейчас можно купить.
 * Сортировка — от дешёвых к дорогим, двойной клик открывает подарок.
 */
export function ListingsTable({ listings, highlight }: Props) {
  if (!listings.length) {
    return (
      <div className="table">
        <div className="table__footer">
          Лотов нет: площадки ещё качают витрину или в заданном диапазоне цен ничего не продаётся.
        </div>
      </div>
    );
  }

  return (
    <div className="table">
      <table>
        <thead>
          <tr>
            <th>Площадка</th>
            <th>Модель</th>
            <th>Фон</th>
            <th>Символ</th>
            <th className="right">№</th>
            <th className="right">Цена, TON</th>
            <th className="right">Цена, $</th>
            <th className="right stars">Цена, ★</th>
          </tr>
        </thead>
        <tbody>
          {listings.map((lot) => (
            <tr
              key={lot.id}
              className={highlight != null && lot.number === highlight ? 'row--highlight' : undefined}
              onDoubleClick={() => lot.link && window.open(lot.link, '_blank')}
              title={lot.link ?? undefined}
            >
              <td className={`market market--${lot.market.toLowerCase()}`}>{lot.market}</td>
              <td>{lot.model ?? ''}</td>
              <td>{lot.backdrop ?? ''}</td>
              <td>{lot.symbol ?? ''}</td>
              <td className="right">{lot.number ?? ''}</td>
              <td className="right">
                {lot.priceTon.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </td>
              <td className="right">{lot.priceUsd !== null ? `$${lot.priceUsd.toLocaleString('ru-RU')}` : ''}</td>
              <td className="right stars">{lot.stars !== null ? `${lot.stars.toLocaleString('ru-RU')} ★` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="table__footer">Двойной клик — открыть подарок в Telegram</div>
    </div>
  );
}

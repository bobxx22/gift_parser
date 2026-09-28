import type { Floor, OfficialValue, RatesInfo, Stats } from '../types';

interface Props {
  stats: Stats;
  floors: Floor[];
  official: OfficialValue | null;
  rates: RatesInfo | null;
}

function ton(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TON`;
}

function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return `$${value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}`;
}

function stars(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return `${value.toLocaleString('ru-RU')} ★`;
}

function ago(iso: string | null): string {
  if (!iso) return '';
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return `${Math.round(hours * 60)} мин назад`;
  if (hours < 48) return `${Math.round(hours)} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

/** Карточки со сводкой: под каждой ценой — доллары и звёзды (цена покупки). */
export function StatCards({ stats, floors, official, rates }: Props) {
  const rate = rates?.spot ?? null;
  const convert = (value: number | null) => {
    if (value === null || !rate) return { usd: null, stars: null };
    const dollars = value * rate;
    return { usd: dollars, stars: dollars / (rates?.starBuyUsd ?? 0.015) };
  };

  const best = floors.length ? floors[0] : null;
  const median = convert(stats.count ? stats.median : null);
  const trimmed = convert(stats.count ? stats.trimmedAverage : null);
  const last = convert(stats.lastPrice);

  const cards = [
    { title: 'Медиана', value: stats.count ? ton(stats.median) : '—', ...median },
    { title: 'Средняя без выбросов', value: stats.count ? ton(stats.trimmedAverage) : '—', ...trimmed },
    {
      title: `Последняя продажа${stats.lastTs ? ` · ${ago(stats.lastTs)}` : ''}`,
      value: ton(stats.lastPrice),
      ...last,
    },
    {
      title: 'Мин — Макс',
      value: stats.count
        ? `${stats.min.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} — ${stats.max.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}`
        : '—',
      usd: null,
      stars: null,
    },
    {
      title: 'Сделок',
      value: String(stats.count),
      sub: Object.entries(stats.perMarket)
        .map(([market, count]) => `${market}: ${count}`)
        .join(', '),
      usd: null,
      stars: null,
    },
    {
      title: best ? `Флор · ${best.market}` : 'Флор',
      value: best ? ton(best.priceTon) : '—',
      usd: best?.priceUsd ?? null,
      stars: best?.stars ?? null,
    },
  ];

  return (
    <>
      <div className="cards">
        {cards.map((card) => (
          <div className="card" key={card.title}>
            <div className="card__title">{card.title}</div>
            <div className="card__value">{card.value}</div>
            <div className="card__sub">
              {card.usd !== null && card.usd !== undefined ? <span>{usd(card.usd)}</span> : null}
              {card.stars !== null && card.stars !== undefined ? (
                <span className="stars">{stars(Math.round(card.stars))}</span>
              ) : null}
              {'sub' in card && card.sub ? <span className="muted">{card.sub}</span> : null}
            </div>
          </div>
        ))}
      </div>

      <div className="floors">
        <div className="floors__list">
          {floors.map((floor) => (
            <span key={floor.market} className={`market market--${floor.market.toLowerCase()}`}>
              {floor.market} {ton(floor.priceTon)} {floor.priceUsd !== null ? `(${usd(floor.priceUsd)})` : ''}
            </span>
          ))}
          {official ? (
            <span className="muted">
              Оценка Telegram: {official.average?.toLocaleString('ru-RU')} {official.currency} · лотов{' '}
              {official.listedCount}
            </span>
          ) : null}
        </div>
        <div className="floors__rate">
          {best?.stars ? <span className="stars">флор {stars(best.stars)}</span> : null}
          {rate ? <span className="muted">TON ≈ {usd(rate)}</span> : null}
        </div>
      </div>
    </>
  );
}

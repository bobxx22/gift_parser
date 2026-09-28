import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';

import type { Floor, Stats, Trade } from '../types';
import { gradient } from './GiftPicker';

const MARKET_COLORS: Record<string, string> = {
  MRKT: '#ff595a',
  Portals: '#4c8dff',
  Fragment: '#41c987',
  Telegram: '#ffc65c',
  Tonnel: '#c792ea',
};

/** Геометрия области построения — по ней определяем, за что тянет мышь. */
const MARGIN = { top: 12, right: 8, bottom: 6, left: 10 };
const PRICE_AXIS_WIDTH = 64;
const TIME_AXIS_HEIGHT = 26;
const CHART_HEIGHT = 260;

interface Props {
  trades: Trade[];
  stats: Stats;
  floors: Floor[];
  /** Экземпляр из поиска по ссылке: обводим белым и подписываем сверху. */
  highlight?: number | null;
}

interface Point {
  x: number;
  y: number;
  trade: Trade;
}

type Zone = 'plot' | 'price' | 'time';
type Range = [number, number];

interface DragState {
  zone: Zone;
  startX: number;
  startY: number;
  x: Range;
  y: Range;
}

/** Карточка подарка под курсором: картинка на его фоне и цена в TON / $ / ★. */
function GiftTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Point }> }) {
  if (!active || !payload?.length) return null;
  const { trade } = payload[0].payload;
  return (
    <div className="tooltip">
      <div className="tooltip__image" style={{ background: gradient(trade.backdropColors) }}>
        {trade.image ? <img src={trade.image} alt="" /> : null}
      </div>
      <div className="tooltip__body">
        <div className="tooltip__title">
          {trade.giftName ?? `${trade.collection} #${trade.number ?? '?'}`}
        </div>
        <div className="tooltip__price">{trade.priceTon.toLocaleString('ru-RU')} TON</div>
        <div className="tooltip__money">
          {trade.priceUsd !== null ? <span>${trade.priceUsd.toLocaleString('ru-RU')}</span> : null}
          {trade.stars !== null ? (
            <span className="stars">{trade.stars.toLocaleString('ru-RU')} ★</span>
          ) : null}
        </div>
        {trade.starsSell !== null ? (
          <div className="tooltip__row">продавцу за звёзды: {trade.starsSell.toLocaleString('ru-RU')} ★</div>
        ) : null}
        <div className="tooltip__row">Площадка: {trade.market}</div>
        <div className="tooltip__row">Дата: {new Date(trade.ts).toLocaleString('ru-RU')}</div>
        {trade.model ? <div className="tooltip__row">Модель: {trade.model}</div> : null}
        {trade.backdrop ? <div className="tooltip__row">Фон: {trade.backdrop}</div> : null}
        {trade.symbol ? <div className="tooltip__row">Символ: {trade.symbol}</div> : null}
      </div>
    </div>
  );
}

/** Белый кружок на искомом экземпляре; подпись — только у самой свежей точки. */
function HighlightDot(props: { cx?: number; cy?: number; payload?: Point; labelFor?: number }) {
  const { cx, cy, payload, labelFor } = props;
  if (cx == null || cy == null) return null;
  const showLabel = payload?.x === labelFor;
  const label = payload?.trade.giftName ?? `#${payload?.trade.number ?? ''}`;
  return (
    <g>
      <circle cx={cx} cy={cy} r={7} fill="none" stroke="#ffffff" strokeWidth={2} />
      <circle cx={cx} cy={cy} r={3} fill="#ffffff" />
      {showLabel ? (
        <text x={cx} y={cy - 12} textAnchor="end" fill="#ffffff" fontSize={11} fontWeight={600}>
          {label}
        </text>
      ) : null}
    </g>
  );
}

function pad(range: Range, ratio = 0.04): Range {
  const span = range[1] - range[0] || Math.abs(range[0]) || 1;
  return [range[0] - span * ratio, range[1] + span * ratio];
}

function clampSpan(range: Range, min: number): Range {
  const span = range[1] - range[0];
  if (span >= min) return range;
  const center = (range[0] + range[1]) / 2;
  return [center - min / 2, center + min / 2];
}

/** Цены отрицательными не бывают — не даём уехать ниже нуля. */
function clampPrice(range: Range): Range {
  const span = Math.max(range[1] - range[0], 0.01);
  if (range[0] >= 0) return range;
  return [0, span];
}

function formatPrice(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toLocaleString('ru-RU', { maximumFractionDigits: digits });
}

/**
 * График сделок с управлением как в TradingView:
 *   • тянуть по самому полю — панорамирование;
 *   • тянуть по ценовой шкале справа — сжать/растянуть цену;
 *   • тянуть по шкале времени снизу — сжать/растянуть время;
 *   • колесо — зум по времени, Shift + колесо — сдвиг влево/вправо;
 *   • двойной клик — вернуть авто-масштаб.
 */
export function PriceChart({ trades, stats, floors, highlight }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [xDomain, setXDomain] = useState<Range | null>(null);
  const [yDomain, setYDomain] = useState<Range | null>(null);
  const [zone, setZone] = useState<Zone>('plot');
  const [dragging, setDragging] = useState(false);

  const sales = useMemo(() => trades.filter((trade) => trade.kind === 'sale'), [trades]);

  const { byMarket, highlighted, bounds } = useMemo(() => {
    const grouped = new Map<string, Point[]>();
    const marked: Point[] = [];
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const trade of sales) {
      const point: Point = { x: Date.parse(trade.ts), y: trade.priceTon, trade };
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
      if (highlight != null && trade.number === highlight) marked.push(point);
      const list = grouped.get(trade.market) ?? [];
      list.push(point);
      grouped.set(trade.market, list);
    }
    return {
      byMarket: grouped,
      highlighted: marked,
      bounds: {
        x: pad([minX, maxX], 0.02) as Range,
        y: pad([Math.min(0, minY), maxY], 0.08) as Range,
      },
    };
  }, [sales, highlight]);

  // Новый поиск — возвращаем авто-масштаб.
  const signature = `${sales.length}|${sales[0]?.id ?? ''}`;
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current !== signature) {
      lastSignature.current = signature;
      setXDomain(null);
      setYDomain(null);
    }
  }, [signature]);

  const activeX = xDomain ?? bounds.x;
  const activeY = yDomain ?? bounds.y;

  const zoneAt = useCallback((event: { clientX: number; clientY: number }): Zone => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return 'plot';
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    if (x > box.width - PRICE_AXIS_WIDTH - MARGIN.right) return 'price';
    if (y > CHART_HEIGHT - TIME_AXIS_HEIGHT - MARGIN.bottom) return 'time';
    return 'plot';
  }, []);

  const plotSize = () => {
    const box = boxRef.current?.getBoundingClientRect();
    const width = Math.max(1, (box?.width ?? 600) - PRICE_AXIS_WIDTH - MARGIN.left - MARGIN.right);
    const height = Math.max(1, CHART_HEIGHT - TIME_AXIS_HEIGHT - MARGIN.top - MARGIN.bottom);
    return { width, height };
  };

  const onMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const current = zoneAt(event);
    dragRef.current = {
      zone: current,
      startX: event.clientX,
      startY: event.clientY,
      x: activeX,
      y: activeY,
    };
    setDragging(true);
    event.preventDefault();
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const { width, height } = plotSize();
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;

      if (drag.zone === 'plot') {
        // Панорамирование: тащим область в обратную сторону движения мыши.
        const spanX = drag.x[1] - drag.x[0];
        const spanY = drag.y[1] - drag.y[0];
        const shiftX = (dx / width) * spanX;
        const shiftY = (dy / height) * spanY;
        setXDomain([drag.x[0] - shiftX, drag.x[1] - shiftX]);
        setYDomain(clampPrice([drag.y[0] + shiftY, drag.y[1] + shiftY]));
        return;
      }

      if (drag.zone === 'price') {
        // Тянем вниз — диапазон цен растягивается, вверх — сжимается.
        const factor = Math.exp(dy / 160);
        const center = (drag.y[0] + drag.y[1]) / 2;
        const half = ((drag.y[1] - drag.y[0]) / 2) * factor;
        setYDomain(clampPrice(clampSpan([center - half, center + half], 0.01)));
        return;
      }

      // Шкала времени: правый край закреплён, тянем влево — растягиваем.
      const factor = Math.exp(-dx / 220);
      const right = drag.x[1];
      const span = (drag.x[1] - drag.x[0]) * factor;
      setXDomain(clampSpan([right - span, right], 60_000));
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  // Колесо: зум по времени вокруг курсора, Shift — сдвиг влево/вправо.
  useEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const span = activeX[1] - activeX[0];
      if (event.shiftKey) {
        const shift = (event.deltaY || event.deltaX) * (span / 800);
        setXDomain([activeX[0] + shift, activeX[1] + shift]);
        return;
      }
      const box = node.getBoundingClientRect();
      const { width } = plotSize();
      const offset = Math.min(Math.max(event.clientX - box.left - MARGIN.left, 0), width);
      const anchor = activeX[0] + (offset / width) * span;
      const factor = Math.exp(event.deltaY / 500);
      const next: Range = [
        anchor - (anchor - activeX[0]) * factor,
        anchor + (activeX[1] - anchor) * factor,
      ];
      setXDomain(clampSpan(next, 60_000));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [activeX]);

  if (!sales.length) {
    return <div className="chart chart--empty">Пока нет сделок — начни поиск</div>;
  }

  const zoomed = xDomain !== null || yDomain !== null;
  const labelFor = highlighted.length ? Math.max(...highlighted.map((point) => point.x)) : undefined;
  const cursor = dragging
    ? zone === 'plot'
      ? 'grabbing'
      : zone === 'price'
        ? 'ns-resize'
        : 'ew-resize'
    : zone === 'price'
      ? 'ns-resize'
      : zone === 'time'
        ? 'ew-resize'
        : 'grab';

  return (
    <div
      className="chart"
      ref={boxRef}
      style={{ cursor }}
      onMouseDown={onMouseDown}
      onMouseMove={(event) => {
        if (!dragging) setZone(zoneAt(event));
      }}
      onDoubleClick={() => {
        setXDomain(null);
        setYDomain(null);
      }}
    >
      {zoomed ? (
        <button
          className="chart__reset"
          onClick={(event) => {
            event.stopPropagation();
            setXDomain(null);
            setYDomain(null);
          }}
          title="Вернуть масштаб (или двойной клик)"
        >
          сброс
        </button>
      ) : null}

      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <ScatterChart margin={MARGIN}>
          <CartesianGrid stroke="#2a2f3d" />
          <XAxis
            type="number"
            dataKey="x"
            domain={activeX}
            allowDataOverflow
            height={TIME_AXIS_HEIGHT}
            tickFormatter={(value) => {
              const span = activeX[1] - activeX[0];
              const date = new Date(value);
              return span < 3 * 86_400_000
                ? date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
                : date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
            }}
            stroke="#8b90a0"
            fontSize={11}
          />
          <YAxis
            type="number"
            dataKey="y"
            orientation="right"
            domain={activeY}
            allowDataOverflow
            stroke="#8b90a0"
            fontSize={11}
            width={PRICE_AXIS_WIDTH}
            tickFormatter={formatPrice}
          />
          <ZAxis range={[36, 36]} />
          <Tooltip
            content={<GiftTooltip />}
            cursor={{ stroke: '#4c8dff', strokeDasharray: '3 3' }}
            isAnimationActive={false}
            wrapperStyle={{ display: dragging ? 'none' : undefined }}
          />
          <ReferenceLine
            y={stats.median}
            stroke="#41c987"
            strokeDasharray="6 4"
            label={{
              value: `медиана ${stats.median.toFixed(0)}`,
              fill: '#41c987',
              fontSize: 11,
              position: 'insideTopLeft',
            }}
          />
          {floors.map((floor) => (
            <ReferenceLine
              key={floor.market}
              y={floor.priceTon}
              stroke={MARKET_COLORS[floor.market] ?? '#8b90a0'}
              strokeDasharray="2 4"
              strokeOpacity={0.5}
            />
          ))}
          {[...byMarket.entries()].map(([market, points]) => (
            <Scatter
              key={market}
              name={`${market} (${points.length})`}
              data={points}
              fill={MARKET_COLORS[market] ?? '#4c8dff'}
              fillOpacity={0.9}
              isAnimationActive={false}
            />
          ))}
          {highlighted.length ? (
            <Scatter
              key="highlight"
              name={`искомый (${highlighted.length})`}
              data={highlighted}
              shape={<HighlightDot labelFor={labelFor} />}
              isAnimationActive={false}
            />
          ) : null}
        </ScatterChart>
      </ResponsiveContainer>

      <div className="chart__legend">
        {[...byMarket.entries()].map(([market, points]) => (
          <span key={market} style={{ color: MARKET_COLORS[market] ?? '#4c8dff' }}>
            ● {market} ({points.length})
          </span>
        ))}
        <span className="muted chart__hint">
          колесо — время, Shift+колесо — сдвиг, шкалы справа и снизу — масштаб, двойной клик — сброс
        </span>
      </div>
    </div>
  );
}

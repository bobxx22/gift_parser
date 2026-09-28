"""Статистика по продажам."""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from datetime import datetime

from .markets.base import Event


@dataclass
class Stats:
    count: int = 0
    minimum: float = 0.0
    maximum: float = 0.0
    average: float = 0.0
    median: float = 0.0
    p25: float = 0.0
    p75: float = 0.0
    trimmed_average: float = 0.0
    last_price: float | None = None
    last_ts: datetime | None = None
    avg_last5: float | None = None
    volume: float = 0.0
    per_market: dict[str, int] = field(default_factory=dict)

    @property
    def empty(self) -> bool:
        return self.count == 0


def percentile(values: list[float], q: float) -> float:
    """Перцентиль методом линейной интерполяции (как numpy.percentile)."""
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * q
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    weight = position - low
    return ordered[low] * (1 - weight) + ordered[high] * weight


def compute(events: list[Event]) -> Stats:
    """Считает статистику по списку событий (ожидаются продажи)."""
    prices = [e.price for e in events if e.price > 0]
    if not prices:
        return Stats()

    by_time = sorted((e for e in events if e.price > 0), key=lambda e: e.ts, reverse=True)
    p25 = percentile(prices, 0.25)
    p75 = percentile(prices, 0.75)
    iqr = p75 - p25
    # Отбрасываем выбросы по правилу Тьюки — «реальная» цена без случайных проливов.
    core = [p for p in prices if p25 - 1.5 * iqr <= p <= p75 + 1.5 * iqr] or prices

    per_market: dict[str, int] = {}
    for event in events:
        per_market[event.market] = per_market.get(event.market, 0) + 1

    last_five = [e.price for e in by_time[:5]]
    return Stats(
        count=len(prices),
        minimum=min(prices),
        maximum=max(prices),
        average=sum(prices) / len(prices),
        median=statistics.median(prices),
        p25=p25,
        p75=p75,
        trimmed_average=sum(core) / len(core),
        last_price=by_time[0].price,
        last_ts=by_time[0].ts,
        avg_last5=sum(last_five) / len(last_five),
        volume=sum(prices),
        per_market=per_market,
    )

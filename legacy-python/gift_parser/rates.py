"""Курс TON/USD по дням и пересчёт цен в USDT и Telegram Stars.

История хранится в `ton_usd.json` рядом с проектом: {"YYYY-MM-DD": цена}.
Первый запуск тянет 2 года дневных свечей с Binance (TONUSDT), при недоступности —
с CoinGecko. Если нужного дня в списке нет, он догружается точечно и дописывается
в файл; совсем старые даты берут ближайшую известную цену.

Telegram Stars: цены зафиксированы пользователем — покупка 0.0150 $, продажа 0.0118 $.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .markets.base import new_session, to_float

STAR_BUY_USD = 0.0150
STAR_SELL_USD = 0.0118
STAR = "★"

BINANCE = "https://api.binance.com/api/v3"
COINGECKO = "https://api.coingecko.com/api/v3/coins/the-open-network/market_chart"
COINGECKO_RANGE = COINGECKO + "/range"
COINGECKO_SPOT = "https://api.coingecko.com/api/v3/simple/price"
HISTORY_DAYS = 730
DAY_MS = 86_400_000


def _day(moment) -> str:
    if isinstance(moment, str):
        return moment[:10]
    if isinstance(moment, (int, float)):
        moment = datetime.fromtimestamp(moment, tz=timezone.utc)
    if isinstance(moment, datetime):
        return moment.astimezone(timezone.utc).strftime("%Y-%m-%d")
    if isinstance(moment, date):
        return moment.strftime("%Y-%m-%d")
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


class TonRates:
    """Курс TON в долларах: история по дням + текущая цена."""

    def __init__(self, path: Path, timeout: int = 20) -> None:
        self.path = Path(path)
        self.timeout = timeout
        self.session = new_session(timeout)
        self.prices: dict[str, float] = {}
        self.updated_at: float = 0.0
        self.spot: float | None = None
        self.spot_ts: float = 0.0
        self.source: str = ""
        self._lock = threading.Lock()
        self._missing: set[str] = set()
        self._load()

    # ------------------------------------------------------------------ файл
    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        prices = payload.get("prices") if isinstance(payload, dict) else None
        if isinstance(prices, dict):
            self.prices = {str(k): float(v) for k, v in prices.items() if v}
            self.updated_at = float(payload.get("updated_at") or 0)
            self.source = str(payload.get("source") or "")

    def save(self) -> None:
        payload = {
            "source": self.source,
            "updated_at": self.updated_at,
            "days": len(self.prices),
            "prices": dict(sorted(self.prices.items())),
        }
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=0), encoding="utf-8")
        tmp.replace(self.path)

    @property
    def ready(self) -> bool:
        return len(self.prices) > 30

    @property
    def last_day(self) -> str | None:
        return max(self.prices) if self.prices else None

    # ------------------------------------------------------------- загрузка
    def _binance_klines(self, start_ms: int | None = None, limit: int = 1000) -> dict[str, float]:
        params = {"symbol": "TONUSDT", "interval": "1d", "limit": limit}
        if start_ms is not None:
            params["startTime"] = start_ms
        response = self.session.get(f"{BINANCE}/klines", params=params, timeout=self.timeout)
        if response.status_code != 200:
            raise RuntimeError(f"Binance {response.status_code}: {response.text[:120]}")
        out = {}
        for row in response.json():
            out[_day(row[0] / 1000)] = float(row[4])  # цена закрытия дня
        return out

    def _coingecko(self, days: int = 365) -> dict[str, float]:
        # Бесплатный CoinGecko отдаёт максимум 365 дней, зато свежие.
        response = self.session.get(
            COINGECKO,
            params={"vs_currency": "usd", "days": min(days, 365), "interval": "daily"},
            timeout=self.timeout,
        )
        if response.status_code != 200:
            raise RuntimeError(f"CoinGecko {response.status_code}")
        out = {}
        for stamp, price in (response.json() or {}).get("prices", []):
            out[_day(stamp / 1000)] = float(price)
        return out

    def _coingecko_range(self, start: datetime, end: datetime) -> dict[str, float]:
        response = self.session.get(
            COINGECKO_RANGE,
            params={"vs_currency": "usd", "from": int(start.timestamp()),
                    "to": int(end.timestamp())},
            timeout=self.timeout,
        )
        if response.status_code != 200:
            raise RuntimeError(f"CoinGecko range {response.status_code}")
        out = {}
        for stamp, price in (response.json() or {}).get("prices", []):
            out.setdefault(_day(stamp / 1000), float(price))
        return out

    def refresh(self, force: bool = False, on_progress=None) -> int:
        """Догружает историю (при первом запуске — 2 года)."""
        with self._lock:
            today = _day(datetime.now(timezone.utc))
            if not force and self.prices and self.last_day == today:
                return 0
            before = len(self.prices)
            errors = []
            used = []
            # Binance держит длинную историю, CoinGecko — свежие 365 дней.
            # Собираем оба: сначала старое, сверху свежее.
            for name, loader in (
                ("binance", lambda: self._binance_klines(
                    start_ms=int((time.time() - HISTORY_DAYS * 86400) * 1000))),
                ("coingecko", self._coingecko),
            ):
                try:
                    if on_progress:
                        on_progress(f"Курс TON: {name}…")
                    fetched = loader()
                    if fetched:
                        self.prices.update(fetched)
                        used.append(name)
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"{name}: {exc}")
            if used:
                self.source = "+".join(used)
            if not self.prices:
                raise RuntimeError("Не удалось загрузить курс TON: " + "; ".join(errors))
            self.updated_at = time.time()
            self._missing.clear()
            self.save()
            return len(self.prices) - before

    def fetch_day(self, day: str) -> float | None:
        """Точечно догружает день, которого нет в списке."""
        if day in self._missing:
            return None
        try:
            start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            return None
        fetched = {}
        for loader in (
            lambda: self._binance_klines(start_ms=int(start.timestamp() * 1000), limit=2),
            lambda: self._coingecko_range(start - timedelta(days=1), start + timedelta(days=2)),
        ):
            try:
                fetched = loader()
            except Exception:  # noqa: BLE001
                fetched = {}
            if fetched.get(day):
                break
        if fetched:
            self.prices.update(fetched)
            self.save()
        price = self.prices.get(day)
        if price is None:
            self._missing.add(day)
        return price

    def spot_price(self, ttl: int = 120) -> float | None:
        """Текущая цена TON (для сегодняшних сделок и активных лотов)."""
        if self.spot and time.time() - self.spot_ts < ttl:
            return self.spot
        try:
            response = self.session.get(
                COINGECKO_SPOT,
                params={"ids": "the-open-network", "vs_currencies": "usd"},
                timeout=self.timeout,
            )
            if response.status_code == 200:
                price = to_float((response.json() or {}).get("the-open-network", {}).get("usd"))
                if price:
                    self.spot, self.spot_ts = price, time.time()
                    return self.spot
        except Exception:  # noqa: BLE001
            pass
        try:
            response = self.session.get(
                f"{BINANCE}/ticker/price", params={"symbol": "TONUSDT"}, timeout=self.timeout
            )
            if response.status_code == 200:
                self.spot = to_float(response.json().get("price")) or None
                self.spot_ts = time.time()
        except Exception:  # noqa: BLE001
            pass
        return self.spot

    # ---------------------------------------------------------------- расчёт
    def price_on(self, moment, allow_fetch: bool = True) -> float | None:
        """Курс TON/USD на дату события."""
        if not self.prices:
            return self.spot
        day = _day(moment)
        price = self.prices.get(day)
        if price is not None:
            return price
        today = _day(datetime.now(timezone.utc))
        if day >= today:
            return self.spot_price() or self.prices.get(self.last_day or "")
        if allow_fetch and day not in self._missing:
            price = self.fetch_day(day)
            if price is not None:
                return price
        # Нет данных за этот день (пробел в свечах) — берём ближайший известный.
        return self._nearest(day)

    def _nearest(self, day: str) -> float | None:
        if not self.prices:
            return None
        try:
            target = datetime.strptime(day, "%Y-%m-%d").date()
        except ValueError:
            return None
        for shift in range(1, 8):
            for candidate in (target - timedelta(days=shift), target + timedelta(days=shift)):
                price = self.prices.get(candidate.strftime("%Y-%m-%d"))
                if price is not None:
                    return price
        keys = sorted(self.prices)
        return self.prices[keys[0] if day < keys[0] else keys[-1]]

    def usd(self, ton: float, moment=None, allow_fetch: bool = True) -> float | None:
        if moment is not None:
            rate = self.price_on(moment, allow_fetch=allow_fetch)
        else:
            rate = self.spot or self.prices.get(self.last_day or "")
            if rate is None and allow_fetch:
                rate = self.spot_price()
        if not rate:
            return None
        return ton * rate

    def stars(self, ton: float, moment=None, mode: str = "buy",
              allow_fetch: bool = True) -> float | None:
        """Сколько это в звёздах: по цене покупки (0.0150 $) или продажи (0.0118 $)."""
        usd = self.usd(ton, moment, allow_fetch=allow_fetch)
        if usd is None:
            return None
        rate = STAR_BUY_USD if mode == "buy" else STAR_SELL_USD
        return usd / rate


def format_usd(value: float | None) -> str:
    if value is None:
        return "—"
    if value >= 1000:
        return f"${value:,.0f}".replace(",", " ")
    return f"${value:,.2f}".replace(",", " ")


def format_stars(value: float | None) -> str:
    if value is None:
        return "—"
    return f"{value:,.0f} {STAR}".replace(",", " ")

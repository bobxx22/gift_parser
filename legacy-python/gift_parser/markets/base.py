"""Общие типы для клиентов маркетплейсов."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

import requests

USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0.0.0 Mobile Safari/537.36 Telegram-Android/11.5.0"
)

# Типы событий, которые считаем реальной продажей.
SALE_KINDS = {"sale", "purchase", "buy", "lucky_buy", "premarket_sale"}


class MarketError(RuntimeError):
    """Ошибка обращения к API маркетплейса."""


class MarketAuthError(MarketError):
    """Токен протух / не принят — нужно перевыпустить initData."""


@dataclass(frozen=True)
class Filters:
    """Фильтр поиска подарка."""

    collection: str
    model: str | None = None
    backdrop: str | None = None
    symbol: str | None = None
    number: int | None = None
    min_price: float | None = None
    max_price: float | None = None

    def matches(self, event: "Event") -> bool:
        """Доп. проверка на клиенте (часть фильтров API не поддерживает)."""

        def norm(value) -> str:
            # Площадки пишут атрибуты чуть по-разному ("Plush Pepe" / "PlushPepe").
            return "".join(ch for ch in str(value).lower() if ch.isalnum())

        def same(left: str | None, right: str | None) -> bool:
            if not left:
                return True
            return bool(right) and norm(left) == norm(right)

        if not same(self.collection, event.collection):
            return False
        if not same(self.model, event.model):
            return False
        if not same(self.backdrop, event.backdrop):
            return False
        if not same(self.symbol, event.symbol):
            return False
        if self.number is not None and event.number != self.number:
            return False
        if self.min_price is not None and event.price < self.min_price:
            return False
        if self.max_price is not None and event.price > self.max_price:
            return False
        return True


@dataclass(frozen=True)
class Event:
    """Событие рынка, приведённое к общему виду. Цена всегда в TON."""

    market: str
    kind: str
    collection: str
    price: float
    ts: datetime
    model: str | None = None
    backdrop: str | None = None
    symbol: str | None = None
    number: int | None = None
    gift_name: str | None = None
    old_price: float | None = None
    raw: dict = field(default_factory=dict, repr=False, compare=False)

    @property
    def is_sale(self) -> bool:
        return self.kind in SALE_KINDS

    @property
    def link(self) -> str | None:
        """Ссылка на подарок в Telegram (t.me/nft/GiftName-1234)."""
        if self.gift_name and "-" in self.gift_name:
            return f"https://t.me/nft/{self.gift_name}"
        if self.collection and self.number:
            slug = self.collection.replace(" ", "").replace("'", "")
            return f"https://t.me/nft/{slug}-{self.number}"
        return None

    @property
    def attrs(self) -> str:
        parts = [p for p in (self.model, self.backdrop, self.symbol) if p]
        return " / ".join(parts)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_ts(value: str | None) -> datetime:
    """Разбирает ISO-время из API (оба маркета отдают UTC)."""
    if not value:
        return utc_now()
    text = value.strip().replace("Z", "+00:00")
    # У .NET-бэкенда MRKT бывает 7 знаков после запятой — datetime ждёт максимум 6.
    if "." in text:
        head, _, tail = text.partition(".")
        digits = ""
        rest = ""
        for index, char in enumerate(tail):
            if char.isdigit():
                digits += char
            else:
                rest = tail[index:]
                break
        text = f"{head}.{digits[:6]}{rest}"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return utc_now()
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def to_float(value, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def new_session(timeout: int = 25) -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
            "Content-Type": "application/json",
        }
    )
    session.request_timeout = timeout  # type: ignore[attr-defined]
    return session

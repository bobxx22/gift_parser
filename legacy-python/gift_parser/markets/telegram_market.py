"""Клиент официального маркета Telegram (перепродажа подарков внутри Telegram).

Работает через MTProto (Telethon >= 1.44):

    payments.getStarGifts(hash=0)                     -> каталог, title -> gift_id
    payments.getResaleStarGifts(gift_id, offset, ...) -> активные лоты, цена в Stars и TON
    payments.getUniqueStarGiftValueInfo(slug)         -> официальная оценка подарка
    payments.getStarGiftUpgradePreview(gift_id)       -> варианты атрибутов

Истории сделок официальный API не отдаёт: доступны активные лоты, оценка
Telegram (средняя, флор, последняя продажа) и полный список атрибутов с цветами фонов.
"""

from __future__ import annotations

import time
from collections.abc import Iterator

from ..tg_auth import TelegramAuth
from .base import Event, Filters, MarketError, utc_now

NANO = 1_000_000_000

try:
    from telethon.tl.functions import payments
    from telethon.tl.types import (
        StarGiftAttributeIdBackdrop,
        StarGiftAttributeIdModel,
        StarGiftAttributeIdPattern,
    )

    SUPPORTED = hasattr(payments, "GetResaleStarGiftsRequest")
except ImportError:  # pragma: no cover
    payments = None  # type: ignore[assignment]
    SUPPORTED = False

UNSUPPORTED_MESSAGE = (
    "Официальный маркет Telegram требует Telethon >= 1.44 — обнови: pip install -U telethon"
)


class TelegramMarketClient:
    name = "Telegram"
    provides_history = False
    provides_listings = True
    needs_login = True

    def __init__(self, auth: TelegramAuth, timeout: int = 25) -> None:
        self.auth = auth
        self.timeout = timeout
        self._catalog: dict[str, int] | None = None
        self._attributes: dict[int, list] = {}
        self._value_cache: dict[str, tuple[float, dict]] = {}

    # --------------------------------------------------------------- каталог
    def catalog(self, refresh: bool = False) -> dict[str, int]:
        """Название коллекции -> gift_id."""
        if self._catalog is not None and not refresh:
            return self._catalog
        if not SUPPORTED:
            raise MarketError(UNSUPPORTED_MESSAGE)

        async def fetch(client):
            return await client(payments.GetStarGiftsRequest(hash=0))

        result = self.auth.run(fetch)
        catalog = {}
        for gift in getattr(result, "gifts", []):
            title = getattr(gift, "title", None)
            if title:
                catalog[str(title)] = gift.id
        self._catalog = catalog
        return catalog

    def gift_id(self, collection: str) -> int | None:
        catalog = self.catalog()
        if collection in catalog:
            return catalog[collection]
        target = "".join(ch for ch in collection.lower() if ch.isalnum())
        for title, gift_id in catalog.items():
            if "".join(ch for ch in title.lower() if ch.isalnum()) == target:
                return gift_id
        return None

    def attributes(self, gift_id: int) -> list:
        """Полный список атрибутов подарка (модели, символы, фоны с цветами)."""
        if gift_id in self._attributes:
            return self._attributes[gift_id]

        async def fetch(client):
            return await client(payments.GetResaleStarGiftsRequest(
                gift_id=gift_id, offset="", limit=1, sort_by_price=True, attributes_hash=0))

        result = self.auth.run(fetch)
        attributes = list(getattr(result, "attributes", None) or [])
        self._attributes[gift_id] = attributes
        return attributes

    def _attribute_ids(self, gift_id: int, filters: Filters) -> list:
        wanted = {
            "StarGiftAttributeModel": filters.model,
            "StarGiftAttributePattern": filters.symbol,
            "StarGiftAttributeBackdrop": filters.backdrop,
        }
        if not any(wanted.values()):
            return []
        ids = []
        for attribute in self.attributes(gift_id):
            kind = type(attribute).__name__
            target = wanted.get(kind)
            if not target or str(getattr(attribute, "name", "")).lower() != target.lower():
                continue
            if kind == "StarGiftAttributeModel":
                ids.append(StarGiftAttributeIdModel(document_id=attribute.document.id))
            elif kind == "StarGiftAttributePattern":
                ids.append(StarGiftAttributeIdPattern(document_id=attribute.document.id))
            else:
                ids.append(StarGiftAttributeIdBackdrop(backdrop_id=attribute.backdrop_id))
        return ids

    # ----------------------------------------------------------------- лоты
    def listings(self, filters: Filters, limit: int = 30) -> list[Event]:
        if not SUPPORTED:
            raise MarketError(UNSUPPORTED_MESSAGE)
        gift_id = self.gift_id(filters.collection)
        if gift_id is None:
            raise MarketError(f"Telegram: подарок «{filters.collection}» не найден в каталоге")
        attribute_ids = self._attribute_ids(gift_id, filters)

        async def fetch(client):
            collected = []
            offset = ""
            while len(collected) < limit:
                request = payments.GetResaleStarGiftsRequest(
                    gift_id=gift_id,
                    offset=offset,
                    limit=min(50, limit - len(collected)),
                    sort_by_price=True,
                    attributes=attribute_ids or None,
                )
                result = await client(request)
                gifts = list(getattr(result, "gifts", []))
                collected.extend(gifts)
                offset = getattr(result, "next_offset", None)
                if not offset or not gifts:
                    break
            return collected

        gifts = self.auth.run(fetch)
        events = [self._to_event(gift, filters) for gift in gifts]
        return [event for event in events if event and event.price > 0][:limit]

    def floor(self, filters: Filters) -> float | None:
        lots = self.listings(filters, limit=1)
        return lots[0].price if lots else None

    def history_pages(
        self, filters: Filters, only_sales: bool = True, page_size: int = 20, pause: float = 0.0
    ) -> Iterator[list[Event]]:
        """Официальный API истории сделок не отдаёт — генератор пустой."""
        return iter(())

    # -------------------------------------------------------------- оценка
    def value_info(self, slug: str, ttl: int = 300) -> dict | None:
        """Официальная оценка Telegram: флор, средняя, последняя продажа."""
        if not SUPPORTED or not slug:
            return None
        cached = self._value_cache.get(slug)
        if cached and time.time() - cached[0] < ttl:
            return cached[1]

        async def fetch(client):
            return await client(payments.GetUniqueStarGiftValueInfoRequest(slug=slug))

        try:
            result = self.auth.run(fetch)
        except Exception:  # noqa: BLE001 - оценка не критична
            return None
        data = result.to_dict()
        currency = data.get("currency") or ""
        info = {
            "currency": currency,
            "value": self._money(data.get("value")),
            "floor": self._money(data.get("floor_price")),
            "average": self._money(data.get("average_price")),
            "last_sale": self._money(data.get("last_sale_price")),
            "last_sale_date": data.get("last_sale_date"),
            "initial_sale": self._money(data.get("initial_sale_price")),
            "initial_sale_date": data.get("initial_sale_date"),
            "listed_count": data.get("listed_count"),
            "fragment_listed_count": data.get("fragment_listed_count"),
            "is_average": bool(data.get("value_is_average")),
        }
        self._value_cache[slug] = (time.time(), info)
        return info

    @staticmethod
    def _money(value) -> float | None:
        # Telegram отдаёт фиатные суммы в сотых долях валюты.
        return None if value is None else round(float(value) / 100, 2)

    # ------------------------------------------------------------ нормализация
    def _to_event(self, gift, filters: Filters) -> Event | None:
        attributes = {}
        for attribute in getattr(gift, "attributes", []) or []:
            kind = type(attribute).__name__
            name = getattr(attribute, "name", None)
            if kind == "StarGiftAttributeModel":
                attributes["model"] = name
            elif kind == "StarGiftAttributePattern":
                attributes["symbol"] = name
            elif kind == "StarGiftAttributeBackdrop":
                attributes["backdrop"] = name

        price_ton = 0.0
        stars = None
        for amount in getattr(gift, "resell_amount", None) or []:
            if type(amount).__name__ == "StarsTonAmount":
                price_ton = float(getattr(amount, "amount", 0)) / NANO
            elif type(amount).__name__ == "StarsAmount":
                stars = float(getattr(amount, "amount", 0)) + float(
                    getattr(amount, "nanos", 0)
                ) / NANO

        return Event(
            market=self.name,
            kind="active_listing",
            collection=str(getattr(gift, "title", filters.collection) or filters.collection),
            price=round(price_ton, 4),
            ts=utc_now(),
            model=attributes.get("model"),
            backdrop=attributes.get("backdrop"),
            symbol=attributes.get("symbol"),
            number=getattr(gift, "num", None),
            gift_name=getattr(gift, "slug", None),
            raw={"stars": stars, "slug": getattr(gift, "slug", None)},
        )

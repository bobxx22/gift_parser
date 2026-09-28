"""Клиент MRKT (api.tgmrkt.io).

Роуты вытащены из бандла мини-аппа cdn.tgmrkt.io:
    POST /api/v1/auth                {"data": initData, "appId": null}  -> {"token": ...}
    POST /api/v1/feed                {"count", "cursor", <фильтры>}     -> лента рынка
    POST /api/v1/feed/gift/{giftId}  {"count", "cursor", ...}           -> история одного подарка
    POST /api/v1/gifts/saling        {"count", "cursor", <фильтры>}     -> активные лоты
    GET  /api/v1/gifts/collections                                      -> список коллекций
    POST /api/v1/gifts/models        {"collections": [name]}            -> модели коллекций
    POST /api/v1/gifts/backdrops     {"collections": [name]}            -> фоны
    POST /api/v1/gifts/symbols       {"collections": [name]}            -> символы

Авторизация: заголовок `Authorization: <token>` (без Bearer).
Цены — nanoTON (10^9).
"""

from __future__ import annotations

import time
from collections.abc import Iterator

import requests

from ..tg_auth import TelegramAuth
from .base import (
    Event,
    Filters,
    MarketAuthError,
    MarketError,
    new_session,
    parse_ts,
    to_float,
)

NANO = 1_000_000_000

# Значения enum-а фильтра ленты (из бандла).
FEED_TYPES = {
    "sale": "Sale",
    "listing": "Listing",
    "premarket_sale": "PremarketSale",
    "premarket_listing": "PremarketListing",
    "change_price": "ChangePrice",
    "lucky_buy_sale": "LuckyBuySale",
    "lucky_buy": "LuckyBuy",
    "crafting": "Crafting",
    "plinko_win": "PlinkoWin",
}
SALE_FEED_TYPES = ["Sale", "PremarketSale", "LuckyBuySale"]

# Ответ отдаёт типы в snake_case, приводим к общим названиям.
KIND_MAP = {
    "sale": "sale",
    "premarket_sale": "sale",
    "lucky_buy": "sale",
    "lucky_buy_sale": "sale",
    "purchase": "sale",
    "listing": "listing",
    "premarket_listing": "listing",
    "change_price": "price_update",
    "unlisting": "unlisting",
    "return": "return",
    "crafting": "crafting",
}


class MrktClient:
    BASE = "https://api.tgmrkt.io/api/v1"
    name = "MRKT"

    def __init__(self, auth: TelegramAuth, timeout: int = 25) -> None:
        self.auth = auth
        self.timeout = timeout
        self.session = new_session(timeout)
        self.session.headers.update(
            {"Origin": "https://cdn.tgmrkt.io", "Referer": "https://cdn.tgmrkt.io/"}
        )
        self._token: str | None = None

    # ------------------------------------------------------------------- auth
    def authorize(self, force: bool = False) -> str:
        init_data = self.auth.init_data("mrkt", force=force)
        response = self.session.post(
            f"{self.BASE}/auth",
            json={"data": init_data, "appId": None},
            timeout=self.timeout,
        )
        if response.status_code != 200:
            raise MarketAuthError(
                f"MRKT /auth -> {response.status_code}: {response.text[:200]}"
            )
        token = (response.json() or {}).get("token")
        if not token:
            raise MarketAuthError("MRKT /auth не вернул token")
        self._token = token
        self.session.headers["Authorization"] = token
        return token

    def _ensure_token(self) -> None:
        if not self._token:
            self.authorize()

    def _call(self, method: str, path: str, *, json_body=None, params=None, retry: bool = True):
        self._ensure_token()
        url = f"{self.BASE}{path}"
        last_error: Exception | None = None
        response = None
        for attempt in range(2):  # лента иногда отвечает дольше таймаута
            try:
                response = self.session.request(
                    method, url, json=json_body, params=params, timeout=self.timeout
                )
                break
            except requests.Timeout as exc:
                last_error = exc
                time.sleep(0.5 * (attempt + 1))
            except Exception as exc:  # noqa: BLE001
                raise MarketError(f"MRKT {path}: {exc}") from exc
        if response is None:
            raise MarketError(f"MRKT {path}: таймаут ({last_error})")

        if response.status_code in (401, 403) and retry:
            # Токен/initData протухли — перевыпускаем и пробуем ещё раз.
            self.authorize(force=True)
            return self._call(method, path, json_body=json_body, params=params, retry=False)
        if response.status_code != 200:
            raise MarketError(f"MRKT {path} -> {response.status_code}: {response.text[:300]}")
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise MarketError(f"MRKT {path}: ответ не JSON") from exc

    # ------------------------------------------------------------ справочники
    def collections(self) -> list[dict]:
        data = self._call("GET", "/gifts/collections") or []
        return data if isinstance(data, list) else []

    def collection_names(self) -> list[str]:
        names = []
        for item in self.collections():
            name = item.get("name") or item.get("collectionName") or item.get("title")
            if name:
                names.append(str(name))
        return sorted(set(names))

    def models(self, collection: str) -> list[str]:
        data = self._call("POST", "/gifts/models", json_body={"collections": [collection]}) or []
        return sorted({str(x.get("modelName")) for x in data if x.get("modelName")})

    def backdrops(self, collection: str) -> list[str]:
        data = self._call("POST", "/gifts/backdrops", json_body={"collections": [collection]}) or []
        return sorted({str(x.get("backdropName")) for x in data if x.get("backdropName")})

    def symbols(self, collection: str) -> list[str]:
        data = self._call("POST", "/gifts/symbols", json_body={"collections": [collection]}) or []
        return sorted({str(x.get("symbolName")) for x in data if x.get("symbolName")})

    # ------------------------------------------------------------------ лента
    def _feed_filters(self, filters: Filters, types: list[str] | None) -> dict:
        body = {
            "collectionNames": [filters.collection] if filters.collection else [],
            "modelNames": [filters.model] if filters.model else [],
            "backdropNames": [filters.backdrop] if filters.backdrop else [],
            "number": filters.number,
            "type": types or [],
            "minPrice": int(filters.min_price * NANO) if filters.min_price else None,
            "maxPrice": int(filters.max_price * NANO) if filters.max_price else None,
        }
        return body

    def history_pages(
        self,
        filters: Filters,
        only_sales: bool = True,
        page_size: int = 20,
        pause: float = 0.1,
    ) -> Iterator[list[Event]]:
        """Генератор страниц ленты — GUI подтягивает их по мере прокрутки."""
        # Если бэкенд не примет набор enum-ов, ступенчато упрощаем фильтр.
        type_variants = [SALE_FEED_TYPES, ["Sale"], []] if only_sales else [[]]
        variant = 0
        body_filters = self._feed_filters(filters, type_variants[variant])
        cursor: str | None = None
        seen: set[str] = set()
        empty_pages = 0

        while True:
            body = {"count": min(page_size, 100), "cursor": cursor, **body_filters}
            try:
                data = self._call("POST", "/feed", json_body=body)
            except MarketError as exc:
                if "400" in str(exc) and variant + 1 < len(type_variants):
                    variant += 1
                    body_filters["type"] = type_variants[variant]
                    continue
                raise
            items = (data or {}).get("items") or []
            if not items:
                return
            page: list[Event] = []
            for item in items:
                event = self._to_event(item)
                if event is None:
                    continue
                key = str(item.get("id") or "") or f"{event.ts}-{event.price}-{event.number}"
                if key in seen:
                    continue
                seen.add(key)
                if only_sales and not event.is_sale:
                    continue
                if not filters.matches(event):
                    continue
                page.append(event)
            if page:
                empty_pages = 0
                yield page
            else:
                # Страница целиком отфильтровалась — идём дальше, но не бесконечно.
                empty_pages += 1
                if empty_pages >= 15:
                    return
            cursor = (data or {}).get("cursor")
            if not cursor:
                return
            time.sleep(pause)

    def history(
        self,
        filters: Filters,
        limit: int = 300,
        only_sales: bool = True,
        page_size: int = 20,
        pause: float = 0.1,
        on_progress=None,
    ) -> list[Event]:
        """История рынка по фильтру (по умолчанию — только продажи)."""
        events: list[Event] = []
        for page in self.history_pages(filters, only_sales, page_size, pause):
            events.extend(page)
            if on_progress:
                on_progress(len(events))
            if len(events) >= limit:
                break
        return events[:limit]

    def gift_history(self, gift_id: str, limit: int = 50) -> list[Event]:
        """История конкретного подарка (POST /feed/gift/{id})."""
        events: list[Event] = []
        cursor: str | None = None
        while len(events) < limit:
            body = {
                "count": 20,
                "cursor": cursor,
                "collectionNames": [],
                "modelNames": [],
                "backdropNames": [],
                "number": None,
                "type": [],
                "minPrice": None,
                "maxPrice": None,
                "ordering": "Latest",
                "lowToHigh": False,
                "section": "Gifts",
            }
            data = self._call("POST", f"/feed/gift/{gift_id}", json_body=body)
            items = (data or {}).get("items") or []
            if not items:
                break
            for item in items:
                event = self._to_event(item)
                if event:
                    events.append(event)
            cursor = (data or {}).get("cursor")
            if not cursor:
                break
        return events[:limit]

    # ---------------------------------------------------------------- витрина
    def listings(self, filters: Filters, limit: int = 40) -> list[Event]:
        """Активные лоты, отсортированные по цене (для флора)."""
        body_filters = {
            "collectionNames": [filters.collection] if filters.collection else [],
            "modelNames": [filters.model] if filters.model else [],
            "backdropNames": [filters.backdrop] if filters.backdrop else [],
            "symbolNames": [filters.symbol] if filters.symbol else [],
            "minPrice": int(filters.min_price * NANO) if filters.min_price else None,
            "maxPrice": int(filters.max_price * NANO) if filters.max_price else None,
            "number": filters.number,
            "isPremarket": None,
            "isNew": None,
            "luckyBuy": None,
            "giftType": "Upgraded",
            "craftable": None,
            "isCrafted": None,
            "tgCanBeCraftedFrom": None,
            "removeSelfSales": None,
            "isTransferable": None,
            "availableForStaking": None,
            "forGame": None,
            "ordering": "Price",
            "lowToHigh": True,
            "query": None,
        }
        result: list[Event] = []
        cursor = ""
        while len(result) < limit:
            body = {"count": min(20, limit - len(result)), "cursor": cursor, **body_filters}
            data = self._call("POST", "/gifts/saling", json_body=body)
            gifts = (data or {}).get("gifts") or []
            if not gifts:
                break
            for gift in gifts:
                event = self._gift_to_event(gift, kind="active_listing")
                if event and filters.matches(event):
                    result.append(event)
            cursor = (data or {}).get("cursor")
            if not cursor:
                break
        return result

    def floor(self, filters: Filters) -> float | None:
        lots = self.listings(filters, limit=1)
        return lots[0].price if lots else None

    # ------------------------------------------------------------ нормализация
    def _to_event(self, item: dict) -> Event | None:
        gift = item.get("gift") or {}
        if not gift:
            return None
        raw_kind = str(item.get("type") or "").lower()
        amount = to_float(item.get("amount"))
        price = amount / NANO if amount else to_float(gift.get("salePrice")) / NANO
        return Event(
            market=self.name,
            kind=KIND_MAP.get(raw_kind, raw_kind or "unknown"),
            collection=str(gift.get("collectionName") or gift.get("title") or ""),
            price=round(price, 4),
            ts=parse_ts(item.get("date")),
            model=gift.get("modelName") or gift.get("modelTitle"),
            backdrop=gift.get("backdropName"),
            symbol=gift.get("symbolName"),
            number=gift.get("number"),
            gift_name=gift.get("name"),
            raw=item,
        )

    def _gift_to_event(self, gift: dict, kind: str) -> Event | None:
        if not gift:
            return None
        return Event(
            market=self.name,
            kind=kind,
            collection=str(gift.get("collectionName") or gift.get("title") or ""),
            price=round(to_float(gift.get("salePrice")) / NANO, 4),
            ts=parse_ts(gift.get("exportDate")),
            model=gift.get("modelName") or gift.get("modelTitle"),
            backdrop=gift.get("backdropName"),
            symbol=gift.get("symbolName"),
            number=gift.get("number"),
            gift_name=gift.get("name"),
            raw=gift,
        )

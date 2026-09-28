"""Клиент Portals (portal-market.com).

Роуты вытащены из бандла мини-аппа portal-market.com:
    GET /api/collections?limit&offset                 -> коллекции (публично)
    GET /api/collections/filters?short_names=<slug>   -> модели/фоны/символы + их флор (публично)
    GET /api/collections/floors                       -> флор по всем коллекциям (публично)
    GET /api/nfts/search?...                          -> активные лоты (публично)
    GET /api/market/actions/?...                      -> история рынка (нужен токен)

Авторизация: заголовок `Authorization: tma <initData>`.
Цены — строки в TON.
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

# Ответ отдаёт типы в snake_case, приводим к общим названиям.
KIND_MAP = {
    "purchase": "sale",
    "buy": "sale",
    "sale": "sale",
    "sell": "sale",
    "lucky_buy": "sale",
    "premarket_sale": "sale",
    "listing": "listing",
    "price_update": "price_update",
    "unlisting": "unlisting",
    "delist": "unlisting",
    "return": "return",
    "offer": "offer",
}
# Значения фильтра action_types (из бандла).
ACTION_TYPES = ["buy", "sell", "lucky_buy", "listing", "price_update"]
# Сделка может прилететь и как buy, и как sell/lucky_buy — берём все три,
# тип события всё равно перепроверяется локально по KIND_MAP.
SALE_ACTION_TYPES = ["buy", "sell", "lucky_buy"]


class PortalsClient:
    BASE = "https://portal-market.com/api"
    name = "Portals"

    def __init__(self, auth: TelegramAuth | None = None, timeout: int = 25) -> None:
        self.auth = auth
        self.timeout = timeout
        self.session = new_session(timeout)
        self.session.headers.update(
            {"Origin": "https://portal-market.com", "Referer": "https://portal-market.com/"}
        )
        self._collections: list[dict] | None = None

    # ------------------------------------------------------------------- auth
    def authorize(self, force: bool = False) -> None:
        if self.auth is None:
            raise MarketAuthError("Для истории Portals нужен вход в Telegram (python cli.py login)")
        init_data = self.auth.init_data("portals", force=force)
        self.session.headers["Authorization"] = f"tma {init_data}"

    def _call(self, path: str, params: dict | None = None, *, need_auth: bool, retry: bool = True):
        if need_auth and "Authorization" not in self.session.headers:
            self.authorize()
        clean = {k: v for k, v in (params or {}).items() if v not in (None, "", [])}
        response = None
        last_error: Exception | None = None
        for attempt in range(2):
            try:
                response = self.session.get(
                    f"{self.BASE}{path}", params=clean, timeout=self.timeout
                )
                break
            except requests.Timeout as exc:
                last_error = exc
                time.sleep(0.5 * (attempt + 1))
            except Exception as exc:  # noqa: BLE001
                raise MarketError(f"Portals {path}: {exc}") from exc
        if response is None:
            raise MarketError(f"Portals {path}: таймаут ({last_error})")

        if response.status_code in (401, 403) and need_auth and retry:
            self.authorize(force=True)
            return self._call(path, params, need_auth=need_auth, retry=False)
        if response.status_code != 200:
            raise MarketError(
                f"Portals {path} -> {response.status_code}: {response.text[:300]}"
            )
        try:
            return response.json()
        except ValueError as exc:
            raise MarketError(f"Portals {path}: ответ не JSON") from exc

    # ------------------------------------------------------------ справочники
    def collections(self, refresh: bool = False) -> list[dict]:
        if self._collections is not None and not refresh:
            return self._collections
        items: list[dict] = []
        offset = 0
        while True:
            data = self._call(
                "/collections", {"limit": 200, "offset": offset}, need_auth=False
            )
            chunk = (data or {}).get("collections") or []
            if not chunk:
                break
            items.extend(chunk)
            if len(chunk) < 200:
                break
            offset += len(chunk)
            if offset > 5000:
                break
        self._collections = items
        return items

    def collection_names(self) -> list[str]:
        return sorted({str(c.get("name")) for c in self.collections() if c.get("name")})

    def find_collection(self, name: str) -> dict | None:
        if not name:
            return None
        target = name.strip().lower()
        for item in self.collections():
            if str(item.get("name", "")).strip().lower() == target:
                return item
        for item in self.collections():
            if str(item.get("short_name", "")).strip().lower() == target.replace(" ", ""):
                return item
        return None

    def attributes(self, collection: str) -> dict[str, list[dict]]:
        """Модели/фоны/символы коллекции вместе с их флором (публичный роут)."""
        found = self.find_collection(collection)
        if not found:
            return {"models": [], "backdrops": [], "symbols": []}
        short_name = found.get("short_name") or ""
        data = self._call(
            "/collections/filters", {"short_names": short_name}, need_auth=False
        )
        block = ((data or {}).get("collections") or {}).get(short_name) or {}
        return {
            "models": block.get("models") or [],
            "backdrops": block.get("backdrops") or [],
            "symbols": block.get("symbols") or [],
        }

    def floors(self) -> dict[str, float]:
        data = self._call("/collections/floors", None, need_auth=False) or {}
        raw = data.get("floorPrices") or {}
        return {key: to_float(value) for key, value in raw.items()}

    # ------------------------------------------------------------------ лента
    def history_pages(
        self,
        filters: Filters,
        only_sales: bool = True,
        page_size: int = 20,
        pause: float = 0.1,
    ) -> Iterator[list[Event]]:
        """Генератор страниц истории (GET /market/actions/, пагинация по offset)."""
        collection = self.find_collection(filters.collection)
        if not collection:
            raise MarketError(f"Portals: коллекция «{filters.collection}» не найдена")

        base_params = {
            "collection_ids": collection.get("id"),
            "filter_by_models": filters.model,
            "filter_by_backdrops": filters.backdrop,
            "filter_by_symbols": filters.symbol,
            "min_price": filters.min_price,
            "max_price": filters.max_price,
        }
        if only_sales:
            base_params["action_types"] = ",".join(SALE_ACTION_TYPES)

        offset = 0
        seen: set[str] = set()
        drop_action_types = False
        empty_pages = 0
        size = min(page_size, 50)

        while True:
            params = dict(base_params)
            if drop_action_types:
                params.pop("action_types", None)
            params.update({"offset": offset, "limit": size})
            try:
                data = self._call("/market/actions/", params, need_auth=True)
            except MarketError:
                if not drop_action_types and "action_types" in base_params:
                    # Бэкенд не принял значение фильтра — берём всё и фильтруем локально.
                    drop_action_types = True
                    continue
                raise
            actions = (data or {}).get("actions") or []
            if not actions:
                return
            offset += len(actions)
            page: list[Event] = []
            for action in actions:
                event = self._to_event(action)
                if event is None:
                    continue
                key = f"{action.get('created_at')}-{event.number}-{event.price}-{event.kind}"
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
                empty_pages += 1
                if empty_pages >= 15:
                    return
            if len(actions) < size:
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
        """История рынка по фильтру (GET /market/actions/)."""
        events: list[Event] = []
        for page in self.history_pages(filters, only_sales, page_size, pause):
            events.extend(page)
            if on_progress:
                on_progress(len(events))
            if len(events) >= limit:
                break
        return events[:limit]

    # ---------------------------------------------------------------- витрина
    def listings(self, filters: Filters, limit: int = 40) -> list[Event]:
        """Активные лоты, отсортированные по цене (публичный роут)."""
        collection = self.find_collection(filters.collection)
        if not collection:
            raise MarketError(f"Portals: коллекция «{filters.collection}» не найдена")
        params = {
            "offset": 0,
            "limit": min(limit, 50),
            "collection_ids": collection.get("id"),
            "filter_by_models": filters.model,
            "filter_by_backdrops": filters.backdrop,
            "filter_by_symbols": filters.symbol,
            "min_price": filters.min_price,
            "max_price": filters.max_price,
            "status": "listed",
            "sort_by": "price asc",
            "exclude_bundled": "true",
        }
        data = self._call("/nfts/search", params, need_auth=False)
        results = (data or {}).get("results") or []
        events = []
        for item in results:
            event = self._nft_to_event(item, kind="active_listing", price=item.get("price"))
            if event and filters.matches(event):
                events.append(event)
        return events

    def floor(self, filters: Filters) -> float | None:
        lots = self.listings(filters, limit=1)
        return lots[0].price if lots else None

    # ------------------------------------------------------------ нормализация
    @staticmethod
    def _attrs(nft: dict) -> dict[str, str]:
        out: dict[str, str] = {}
        for attribute in nft.get("attributes") or []:
            kind = str(attribute.get("type") or "").lower()
            if kind:
                out[kind] = attribute.get("value")
        return out

    def _to_event(self, action: dict) -> Event | None:
        nft = action.get("nft") or {}
        if not nft:
            return None
        raw_kind = str(action.get("type") or "").lower()
        return self._nft_to_event(
            nft,
            kind=KIND_MAP.get(raw_kind, raw_kind or "unknown"),
            price=action.get("amount"),
            ts=action.get("created_at"),
            old_price=action.get("old_price"),
            raw=action,
        )

    def _nft_to_event(
        self,
        nft: dict,
        kind: str,
        price,
        ts: str | None = None,
        old_price=None,
        raw: dict | None = None,
    ) -> Event | None:
        if not nft:
            return None
        attrs = self._attrs(nft)
        return Event(
            market=self.name,
            kind=kind,
            collection=str(nft.get("name") or ""),
            price=round(to_float(price), 4),
            ts=parse_ts(ts or nft.get("listed_at") or nft.get("updated_at")),
            model=attrs.get("model"),
            backdrop=attrs.get("backdrop"),
            symbol=attrs.get("symbol"),
            number=nft.get("external_collection_number"),
            gift_name=nft.get("tg_id"),
            old_price=to_float(old_price) if old_price else None,
            raw=raw or nft,
        )

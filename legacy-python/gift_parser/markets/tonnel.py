"""Клиент Tonnel Network.

Роуты разобраны из бандла мини-аппа marketplace.tonnel.network:

    POST /api/saleHistory  {"authData": initData, "page", "limit"<=50, "type": "",
                            "filter": {...}, "sort": {"timestamp": -1, "gift_id": -1}}
    POST /api/pageGifts    {"page", "limit", "sort": "<json>", "filter": "<json>",
                            "ref": "", "user_auth": initData}

Тонкости:
  * у `saleHistory` filter/sort — объекты, у `pageGifts` — строки с JSON;
  * `type: ""` означает «все события»; в ответе тип приходит как INTERNAL_SALE / BID;
  * атрибуты хранятся как «Bengal Tiger (2.5%)», поэтому фильтр — regex по началу;
  * хосты: gifts3 (основной), gifts2 (запасной), rs-gifts для RU-региона.

Цены — TON (поле `asset`).
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Iterator

from ..tg_auth import TelegramAuth
from .base import Event, Filters, MarketError, new_session, parse_ts, to_float

HOSTS = ("https://gifts3.tonnel.network", "https://gifts2.tonnel.network")
SALE_TYPES = ("INTERNAL_SALE", "EXTERNAL_SALE", "AUCTION_SALE", "SALE", "PURCHASE")
KIND_MAP = {
    "INTERNAL_SALE": "sale",
    "EXTERNAL_SALE": "sale",
    "AUCTION_SALE": "sale",
    "SALE": "sale",
    "PURCHASE": "sale",
    "BID": "bid",
    "LISTING": "listing",
    "OFFER": "offer",
}


class TonnelClient:
    name = "Tonnel"
    provides_history = True
    provides_listings = True
    needs_login = True

    def __init__(self, auth: TelegramAuth | None = None, timeout: int = 25) -> None:
        self.auth = auth
        self.timeout = timeout
        self.session = new_session(timeout)
        self.session.headers.update(
            {
                "Origin": "https://marketplace.tonnel.network",
                "Referer": "https://marketplace.tonnel.network/",
            }
        )
        self._host = HOSTS[0]

    # ------------------------------------------------------------------ auth
    def _init_data(self, force: bool = False) -> str:
        if self.auth is None:
            raise MarketError("Tonnel: нужен вход в Telegram (python cli.py login)")
        return self.auth.init_data("tonnel", force=force)

    def _post(self, path: str, body: dict, retry: bool = True):
        errors = []
        for host in (self._host, *[h for h in HOSTS if h != self._host]):
            try:
                response = self.session.post(f"{host}{path}", json=body, timeout=self.timeout)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{host}: {exc}")
                continue
            if response.status_code == 403:
                errors.append(f"{host}: 403 Cloudflare")
                continue
            if response.status_code in (401, 419) and retry:
                # initData протухла — перевыпускаем и повторяем один раз.
                body = dict(body)
                fresh = self._init_data(force=True)
                if "authData" in body:
                    body["authData"] = fresh
                if "user_auth" in body:
                    body["user_auth"] = fresh
                return self._post(path, body, retry=False)
            if response.status_code != 200:
                errors.append(f"{host}: {response.status_code} {response.text[:120]}")
                continue
            self._host = host
            try:
                return response.json()
            except ValueError:
                errors.append(f"{host}: ответ не JSON")
        raise MarketError("Tonnel " + path + " -> " + "; ".join(errors))

    # --------------------------------------------------------------- фильтры
    @staticmethod
    def _attr_filter(value: str | None) -> dict | None:
        if not value:
            return None
        # В базе значения вида «Bengal Tiger (2.5%)» — цепляемся за начало строки.
        return {"$regex": "^" + re.escape(value)}

    def _filter(self, filters: Filters) -> dict:
        query: dict = {}
        if filters.collection:
            query["gift_name"] = filters.collection
        for field, value in (
            ("model", filters.model),
            ("backdrop", filters.backdrop),
            ("symbol", filters.symbol),
        ):
            condition = self._attr_filter(value)
            if condition:
                query[field] = condition
        if filters.number:
            query["gift_num"] = filters.number
        return query

    # ------------------------------------------------------------------ данные
    def history_pages(
        self,
        filters: Filters,
        only_sales: bool = True,
        page_size: int = 20,
        pause: float = 0.15,
    ) -> Iterator[list[Event]]:
        init_data = self._init_data()
        page = 1
        size = min(page_size, 50)
        while True:
            body = {
                "authData": init_data,
                "page": page,
                "limit": size,
                "type": "",
                "filter": self._filter(filters),
                "sort": {"timestamp": -1, "gift_id": -1},
            }
            items = self._post("/api/saleHistory", body)
            if not isinstance(items, list) or not items:
                return
            events = []
            for item in items:
                event = self._to_event(item)
                if event is None:
                    continue
                if only_sales and not event.is_sale:
                    continue
                events.append(event)
            if events:
                yield events
            if len(items) < size:
                return
            page += 1
            time.sleep(pause)

    def history(
        self,
        filters: Filters,
        limit: int = 100,
        only_sales: bool = True,
        page_size: int = 20,
        pause: float = 0.15,
        on_progress=None,
    ) -> list[Event]:
        events: list[Event] = []
        for chunk in self.history_pages(filters, only_sales, page_size, pause):
            events.extend(chunk)
            if on_progress:
                on_progress(len(events))
            if len(events) >= limit:
                break
        return events[:limit]

    def listings(self, filters: Filters, limit: int = 30) -> list[Event]:
        query = self._filter(filters)
        query.update({"buyer": {"$exists": False}, "price": {"$exists": True}})
        body = {
            "page": 1,
            "limit": min(limit, 30),
            "sort": json.dumps({"price": 1, "gift_id": -1}),
            "filter": json.dumps(query),
            "ref": "",
            "user_auth": self._init_data() if self.auth else "",
        }
        items = self._post("/api/pageGifts", body)
        if not isinstance(items, list):
            return []
        events = [self._to_event(item, kind="active_listing") for item in items]
        events = [event for event in events if event]
        events.sort(key=lambda event: event.price)
        return events[:limit]

    def floor(self, filters: Filters) -> float | None:
        lots = self.listings(filters, limit=1)
        return lots[0].price if lots else None

    # ------------------------------------------------------------ нормализация
    @staticmethod
    def _clean_attr(value) -> str | None:
        if not value:
            return None
        return str(value).split(" (")[0].strip() or None

    def _to_event(self, item: dict, kind: str | None = None) -> Event | None:
        if not isinstance(item, dict):
            return None
        if str(item.get("asset") or "TON").upper() != "TON":
            return None  # редкие лоты в других монетах в статистику не берём
        price = to_float(item.get("price"))
        collection = item.get("gift_name") or item.get("name") or ""
        if price <= 0 or not collection:
            return None
        raw_kind = str(item.get("type") or "").upper()
        number = item.get("gift_num") or item.get("number")
        return Event(
            market=self.name,
            kind=kind or KIND_MAP.get(raw_kind, raw_kind.lower() or "unknown"),
            collection=str(collection),
            price=round(price, 4),
            ts=parse_ts(item.get("timestamp") or item.get("export_at")),
            model=self._clean_attr(item.get("model")),
            backdrop=self._clean_attr(item.get("backdrop")),
            symbol=self._clean_attr(item.get("symbol")),
            number=int(number) if str(number).isdigit() else None,
            raw=item,
        )

"""Клиент Fragment (fragment.com) — официальная площадка Telegram/TON.

Авторизация не нужна: страницы коллекций отдаются сервером уже с данными.

    /gifts/<short_name>?filter=sold&sort=listed   -> проданные, по дате (история)
    /gifts/<short_name>?filter=sale&sort=price_asc-> активные лоты (флор)
    &query=<текст>                                -> фильтр по модели/фону/символу

Цены — TON. На странице отдаётся 60 карточек, дальше Fragment догружает их
своим внутренним запросом, поэтому глубина истории здесь ограничена 60 сделками.
"""

from __future__ import annotations

import re
from collections.abc import Iterator

from .base import Event, Filters, MarketError, new_session, parse_ts, to_float

ITEM_RE = re.compile(
    r'<a href="/gift/(?P<slug>[^"?]+)[^"]*" class="tm-grid-item">(?P<body>[\s\S]{0,1500}?)</a>'
)
PRICE_RE = re.compile(r'tm-grid-item-value tm-value[^>]*>([^<]*)<')
STATUS_RE = re.compile(r'tm-grid-item-status[^>]*>([^<]*)<')
TIME_RE = re.compile(r'datetime="([^"]+)"')
NUM_RE = re.compile(r'-(\d+)$')


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(name).lower())


class FragmentClient:
    BASE = "https://fragment.com"
    name = "Fragment"
    provides_history = True
    provides_listings = True
    needs_login = False

    def __init__(self, timeout: int = 25) -> None:
        self.timeout = timeout
        self.session = new_session(timeout)
        self.session.headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
                ),
                "Accept": "text/html,application/xhtml+xml",
                "Content-Type": "text/html; charset=utf-8",
            }
        )

    # ------------------------------------------------------------------ запрос
    def _fetch(self, filters: Filters, sold: bool) -> str:
        short = slugify(filters.collection)
        params = {"filter": "sold" if sold else "sale", "sort": "listed" if sold else "price_asc"}
        query = " ".join(
            part for part in (filters.model, filters.backdrop, filters.symbol) if part
        )
        if query:
            params["query"] = query
        try:
            response = self.session.get(
                f"{self.BASE}/gifts/{short}", params=params, timeout=self.timeout
            )
        except Exception as exc:  # noqa: BLE001
            raise MarketError(f"Fragment: {exc}") from exc
        if response.status_code != 200:
            raise MarketError(f"Fragment /gifts/{short} -> {response.status_code}")
        return response.text

    def _parse(self, html: str, filters: Filters, kind: str) -> list[Event]:
        events: list[Event] = []
        for match in ITEM_RE.finditer(html):
            slug = match.group("slug")
            body = match.group("body")
            status_match = STATUS_RE.search(body)
            status = status_match.group(1).strip() if status_match else ""
            if kind == "sale" and status.lower() != "sold":
                continue
            if kind == "active_listing" and status.lower() != "for sale":
                continue
            price_match = PRICE_RE.search(body)
            price = to_float((price_match.group(1) if price_match else "").replace(",", ""))
            if price <= 0:
                continue
            time_match = TIME_RE.search(body)
            num_match = NUM_RE.search(slug)
            events.append(
                Event(
                    market=self.name,
                    kind=kind,
                    collection=filters.collection,
                    price=round(price, 4),
                    ts=parse_ts(time_match.group(1) if time_match else None),
                    # Fragment не показывает атрибуты в списке, но сам список
                    # уже отфильтрован запросом — подставляем то, что искали.
                    model=filters.model,
                    backdrop=filters.backdrop,
                    symbol=filters.symbol,
                    number=int(num_match.group(1)) if num_match else None,
                    gift_name=self._gift_name(slug, filters.collection),
                    raw={"slug": slug, "status": status},
                )
            )
        return events

    @staticmethod
    def _gift_name(slug: str, collection: str) -> str:
        num = NUM_RE.search(slug)
        base = "".join(word.capitalize() for word in re.split(r"[\s\-']+", collection) if word)
        return f"{base}-{num.group(1)}" if num else slug

    # ------------------------------------------------------------------ данные
    def history_pages(
        self,
        filters: Filters,
        only_sales: bool = True,
        page_size: int = 20,
        pause: float = 0.0,
    ) -> Iterator[list[Event]]:
        html = self._fetch(filters, sold=True)
        events = self._parse(html, filters, kind="sale")
        events.sort(key=lambda e: e.ts, reverse=True)
        for index in range(0, len(events), page_size):
            yield events[index : index + page_size]

    def history(
        self,
        filters: Filters,
        limit: int = 60,
        only_sales: bool = True,
        page_size: int = 20,
        pause: float = 0.0,
        on_progress=None,
    ) -> list[Event]:
        events: list[Event] = []
        for page in self.history_pages(filters, only_sales, page_size):
            events.extend(page)
            if on_progress:
                on_progress(len(events))
            if len(events) >= limit:
                break
        return events[:limit]

    def listings(self, filters: Filters, limit: int = 30) -> list[Event]:
        html = self._fetch(filters, sold=False)
        events = self._parse(html, filters, kind="active_listing")
        events.sort(key=lambda e: e.price)
        return events[:limit]

    def floor(self, filters: Filters) -> float | None:
        lots = self.listings(filters, limit=1)
        return lots[0].price if lots else None

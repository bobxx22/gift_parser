"""Общий слой: объединяет площадки в один поиск с постраничной подгрузкой."""

from __future__ import annotations

import csv
import json
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .catalog import GiftCatalog
from .config import Config
from .markets.base import Event, Filters, MarketError
from .markets.fragment import FragmentClient
from .markets.mrkt import MrktClient
from .markets.portals import PortalsClient
from .markets.telegram_market import TelegramMarketClient
from .markets.tonnel import TonnelClient
from .rates import TonRates
from .stats import Stats, compute
from .tg_auth import NotLoggedIn, TelegramAuth

COLLECTIONS_TTL = 6 * 3600


@dataclass(frozen=True)
class SourceInfo:
    key: str
    title: str
    history: bool
    listings: bool
    needs_login: bool
    default_on: bool = True
    note: str = ""


SOURCES: tuple[SourceInfo, ...] = (
    SourceInfo("mrkt", "MRKT", True, True, True),
    SourceInfo("portals", "Portals", True, True, True),
    SourceInfo("fragment", "Fragment", True, True, False,
               note="история до 60 сделок, фильтр по одному атрибуту"),
    SourceInfo("telegram", "Telegram", False, True, True,
               note="официальный маркет: лоты и оценка Telegram, истории нет"),
    SourceInfo("tonnel", "Tonnel", True, True, True,
               note="история сделок и лоты, аукционные ставки не считаются продажами"),
)
SOURCE_BY_KEY = {source.key: source for source in SOURCES}


@dataclass
class SearchQuery:
    collection: str
    model: str | None = None
    backdrop: str | None = None
    symbol: str | None = None
    days: int | None = None
    sources: tuple[str, ...] = ("mrkt", "portals", "fragment", "telegram", "tonnel")
    only_sales: bool = True
    limit: int = 300

    def to_filters(self) -> Filters:
        return Filters(
            collection=self.collection.strip(),
            model=(self.model or None),
            backdrop=(self.backdrop or None),
            symbol=(self.symbol or None),
        )

    @property
    def title(self) -> str:
        parts = [self.collection, self.model, self.backdrop, self.symbol]
        return " / ".join(part for part in parts if part)


@dataclass
class SearchResult:
    """Накопленный результат поиска — пополняется по мере подгрузки страниц."""

    query: SearchQuery
    events: list[Event] = field(default_factory=list)
    listings: list[Event] = field(default_factory=list)
    floors: dict[str, float] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)
    official: dict | None = None
    stats: Stats = field(default_factory=Stats)
    elapsed: float = 0.0

    @property
    def sales(self) -> list[Event]:
        return [event for event in self.events if event.is_sale]

    def recompute(self) -> None:
        self.events.sort(key=lambda event: event.ts, reverse=True)
        self.stats = compute(self.sales)

    def to_csv(self, path: Path) -> Path:
        path = Path(path)
        with path.open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.writer(handle, delimiter=";")
            writer.writerow(
                ["Дата (UTC)", "Площадка", "Событие", "Коллекция", "Модель", "Фон",
                 "Символ", "Номер", "Цена TON", "Ссылка"]
            )
            for event in self.events:
                writer.writerow([
                    event.ts.strftime("%Y-%m-%d %H:%M:%S"),
                    event.market,
                    event.kind,
                    event.collection,
                    event.model or "",
                    event.backdrop or "",
                    event.symbol or "",
                    event.number or "",
                    f"{event.price:.4f}".replace(".", ","),
                    event.link or "",
                ])
        return path


class SearchSession:
    """Поиск с ленивой подгрузкой: страницы тянутся по мере прокрутки в GUI."""

    def __init__(self, service: "GiftPriceService", query: SearchQuery) -> None:
        self.service = service
        self.query = query
        self.filters = query.to_filters()
        self.result = SearchResult(query=query)
        self.started = time.time()
        self._pagers: dict[str, object] = {}
        self._exhausted: set[str] = set()
        self._seen: set[tuple] = set()
        self._since = (
            datetime.now(timezone.utc) - timedelta(days=query.days) if query.days else None
        )
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ шаги
    @property
    def active_sources(self) -> list[SourceInfo]:
        return [SOURCE_BY_KEY[key] for key in self.query.sources if key in SOURCE_BY_KEY]

    @property
    def finished(self) -> bool:
        history_keys = {
            source.key for source in self.active_sources
            if source.history and self.service.client(source.key) is not None
        }
        # Ни одной площадки с историей — листать нечего.
        return history_keys <= self._exhausted

    def prepare(self, on_progress=None) -> SearchResult:
        """Первый шаг: активные лоты, флоры, оценка Telegram, первая страница истории."""
        for source in self.active_sources:
            client = self.service.client(source.key)
            if client is None or not source.listings:
                continue
            if not self.service.supports(source.key, self.filters):
                continue
            if on_progress:
                on_progress(f"{source.title}: лоты…")
            try:
                lots = client.listings(self.filters, limit=30)
                self.result.listings.extend(lots)
                prices = [lot.price for lot in lots if lot.price > 0]
                if prices:
                    self.result.floors[source.title] = min(prices)
            except (MarketError, NotLoggedIn) as exc:
                self.result.errors[f"{source.title} · лоты"] = str(exc)
            except Exception as exc:  # noqa: BLE001
                self.result.errors[f"{source.title} · лоты"] = f"{type(exc).__name__}: {exc}"

        self.result.listings.sort(key=lambda event: event.price)
        self._load_official(on_progress)
        self.load_more(on_progress=on_progress)
        return self.result

    def load_more(self, on_progress=None) -> list[Event]:
        """Тянет по одной странице истории с каждой площадки."""
        fresh: list[Event] = []
        with self._lock:
            for source in self.active_sources:
                if source.key in self._exhausted or not source.history:
                    continue
                client = self.service.client(source.key)
                if client is None:
                    self._exhausted.add(source.key)
                    continue
                if not self.service.supports(source.key, self.filters):
                    reason = self.service.unsupported_reason(source.key, self.filters)
                    if reason:
                        self.result.errors.setdefault(source.title, reason)
                    self._exhausted.add(source.key)
                    continue
                if on_progress:
                    on_progress(f"{source.title}: история…")
                pager = self._pagers.get(source.key)
                if pager is None:
                    try:
                        pager = client.history_pages(
                            self.filters, only_sales=self.query.only_sales
                        )
                    except (MarketError, NotLoggedIn) as exc:
                        self.result.errors[source.title] = str(exc)
                        self._exhausted.add(source.key)
                        continue
                    self._pagers[source.key] = pager
                try:
                    page = next(pager)  # type: ignore[call-overload]
                except StopIteration:
                    self._exhausted.add(source.key)
                    continue
                except (MarketError, NotLoggedIn) as exc:
                    self.result.errors[source.title] = str(exc)
                    self._exhausted.add(source.key)
                    continue
                except Exception as exc:  # noqa: BLE001
                    self.result.errors[source.title] = f"{type(exc).__name__}: {exc}"
                    self._exhausted.add(source.key)
                    continue

                stale = 0
                for event in page:
                    if self._since and event.ts < self._since:
                        stale += 1
                        continue
                    key = (event.market, event.ts, event.price, event.number, event.kind)
                    if key in self._seen:
                        continue
                    self._seen.add(key)
                    fresh.append(event)
                # Лента отсортирована по дате: если страница целиком старше
                # выбранного периода — дальше смысла листать нет.
                if stale and stale == len(page):
                    self._exhausted.add(source.key)

            self.result.events.extend(fresh)
            self.result.recompute()
            self.result.elapsed = time.time() - self.started
        return fresh

    def refresh_new(self, on_progress=None) -> list[Event]:
        """Живое обновление: первая страница каждой площадки, только новые события."""
        fresh: list[Event] = []
        with self._lock:
            for source in self.active_sources:
                if not source.history:
                    continue
                client = self.service.client(source.key)
                if client is None or not self.service.supports(source.key, self.filters):
                    continue
                if on_progress:
                    on_progress(f"{source.title}: проверяю новые…")
                try:
                    pager = client.history_pages(self.filters, only_sales=self.query.only_sales)
                    page = next(iter(pager), [])
                except (MarketError, NotLoggedIn) as exc:
                    self.result.errors[source.title] = str(exc)
                    continue
                except Exception as exc:  # noqa: BLE001
                    self.result.errors[source.title] = f"{type(exc).__name__}: {exc}"
                    continue
                for event in page:
                    if self._since and event.ts < self._since:
                        continue
                    key = (event.market, event.ts, event.price, event.number, event.kind)
                    if key in self._seen:
                        continue
                    self._seen.add(key)
                    fresh.append(event)
            if fresh:
                self.result.events.extend(fresh)
                self.result.recompute()
        return fresh

    def refresh_floors(self, on_progress=None) -> dict[str, float]:
        """Живое обновление флоров и активных лотов."""
        floors: dict[str, float] = {}
        listings: list[Event] = []
        for source in self.active_sources:
            client = self.service.client(source.key)
            if client is None or not source.listings:
                continue
            if not self.service.supports(source.key, self.filters):
                continue
            try:
                lots = client.listings(self.filters, limit=30)
            except Exception:  # noqa: BLE001 - флор не критичен
                continue
            listings.extend(lots)
            prices = [lot.price for lot in lots if lot.price > 0]
            if prices:
                floors[source.title] = min(prices)
        if floors:
            with self._lock:
                self.result.floors.update(floors)
                self.result.listings = sorted(listings, key=lambda event: event.price)
        return floors

    def _load_official(self, on_progress=None) -> None:
        if "telegram" not in self.query.sources:
            return
        client = self.service.client("telegram")
        if client is None:
            return
        slug = None
        for event in self.result.listings:
            if event.market == "Telegram" and event.gift_name:
                slug = event.gift_name
                break
        if not slug:
            return
        if on_progress:
            on_progress("Telegram: оценка…")
        try:
            self.result.official = client.value_info(slug)
        except Exception:  # noqa: BLE001
            self.result.official = None


class GiftPriceService:
    """Фасад: справочники, поиск истории и флоров сразу по всем площадкам."""

    def __init__(self, config: Config | None = None) -> None:
        self.config = config or Config.load()
        self.auth = TelegramAuth(self.config)
        self.mrkt = MrktClient(self.auth, timeout=self.config.request_timeout)
        self.portals = PortalsClient(self.auth, timeout=self.config.request_timeout)
        self.fragment = FragmentClient(timeout=self.config.request_timeout)
        self.telegram = TelegramMarketClient(self.auth, timeout=self.config.request_timeout)
        self.tonnel = TonnelClient(self.auth, timeout=self.config.request_timeout)
        self.catalog = GiftCatalog(self.config, self.portals)
        self.rates = TonRates(self.config.session_path.parent / "ton_usd.json",
                              timeout=self.config.request_timeout)
        self._cache_path = self.config.cache_dir / "collections.json"

    # ------------------------------------------------------------------- auth
    def is_logged_in(self) -> bool:
        try:
            return self.auth.is_logged_in()
        except Exception:  # noqa: BLE001
            return False

    # --------------------------------------------------------------- площадки
    def client(self, key: str):
        return getattr(self, key, None)

    @staticmethod
    def sources() -> tuple[SourceInfo, ...]:
        return SOURCES

    def supports(self, key: str, filters: Filters) -> bool:
        return self.unsupported_reason(key, filters) is None

    @staticmethod
    def unsupported_reason(key: str, filters: Filters) -> str | None:
        if key == "fragment":
            chosen = [x for x in (filters.model, filters.backdrop, filters.symbol) if x]
            if len(chosen) > 1:
                return "Fragment ищет только по одному атрибуту — уточни что-то одно"
        return None

    # ------------------------------------------------------------ справочники
    def collections(self, refresh: bool = False) -> list[str]:
        """Список коллекций: каталог + живые данные площадок."""
        names = {info.name for info in self.catalog.collections()}
        cached = self._read_cache(refresh)
        if cached:
            names.update(cached)
        if not cached or refresh:
            fresh: set[str] = set()
            try:
                fresh.update(self.portals.collection_names())
            except Exception:  # noqa: BLE001
                pass
            try:
                # У MRKT часть коллекций приходит без названия (только id) — их прячем.
                fresh.update(
                    name for name in self.mrkt.collection_names()
                    if name and not str(name).isdigit() and len(str(name)) <= 40
                )
            except Exception:  # noqa: BLE001
                pass
            if fresh:
                names.update(fresh)
                self._write_cache(sorted(names))
        return sorted(names)

    def attributes(self, collection: str) -> dict[str, list[str]]:
        return {
            kind: [item.name for item in self.catalog.attributes(collection, kind)]
            for kind in ("models", "backdrops", "symbols")
        }

    # ------------------------------------------------------------------ поиск
    def session(self, query: SearchQuery) -> SearchSession:
        return SearchSession(self, query)

    def search(self, query: SearchQuery, on_progress=None) -> SearchResult:
        """Разовый поиск (для CLI): тянет страницы, пока не наберёт limit."""
        session = self.session(query)
        session.prepare(on_progress=on_progress)
        idle = 0
        while not session.finished and len(session.result.sales) < query.limit:
            if session.load_more(on_progress=on_progress):
                idle = 0
            else:
                idle += 1
                if idle >= 5:
                    break
        return session.result

    # ------------------------------------------------------------------ кеши
    def _read_cache(self, refresh: bool) -> list[str] | None:
        if refresh or not self._cache_path.exists():
            return None
        try:
            payload = json.loads(self._cache_path.read_text(encoding="utf-8"))
            if time.time() - float(payload.get("ts", 0)) > COLLECTIONS_TTL:
                return None
            return payload.get("names") or None
        except (OSError, ValueError):
            return None

    def _write_cache(self, names: list[str]) -> None:
        try:
            self._cache_path.parent.mkdir(parents=True, exist_ok=True)
            self._cache_path.write_text(
                json.dumps({"ts": time.time(), "names": names}, ensure_ascii=False),
                encoding="utf-8",
            )
        except OSError:
            pass

"""Каталог подарков: коллекции, модели, фоны, символы — с картинками и флором.

Источник данных — `data.json` (тот же формат, что читает main.py) плюс публичные
роуты Portals. Картинки моделей и символов лежат в `downloaded_collections/<short>/`.
"""

from __future__ import annotations

import difflib
import json
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import requests

from .config import Config
from .markets.base import new_session, to_float
from .markets.portals import PortalsClient

STORAGE = "https://storage.portal-market.com/portals-market/gifts"
KINDS = ("models", "backdrops", "symbols")
KIND_DIR = {"models": "models/png", "symbols": "patterns"}


def slugify(name: str) -> str:
    """«Bounty Hunter» -> bountyhunter (правило имён файлов в сторадже Portals)."""
    return re.sub(r"[^a-z0-9]", "", str(name).lower())


def safe_filename(name: str) -> str:
    """Имя файла в том же виде, в каком их сохранял main.py."""
    return "".join(c if c.isalnum() or c in " _-()" else "_" for c in str(name))


@dataclass
class CollectionInfo:
    short_name: str
    name: str
    id: str | None = None
    floor: float | None = None
    supply: int | None = None
    listed: int | None = None
    volume: float | None = None
    day_volume: float | None = None
    photo_url: str | None = None
    is_new: bool = False

    @property
    def subtitle(self) -> str:
        parts = []
        if self.floor:
            parts.append(f"флор {self.floor:,.2f} TON".replace(",", " "))
        if self.supply:
            parts.append(f"{self.supply:,} шт".replace(",", " "))
        return " · ".join(parts)


@dataclass
class AttrInfo:
    name: str
    kind: str
    collection: str
    floor: float | None = None
    supply: int | None = None
    rarity: float | None = None
    url: str | None = None
    colors: dict | None = field(default=None, repr=False)

    @property
    def subtitle(self) -> str:
        parts = []
        if self.floor:
            parts.append(f"флор {self.floor:,.2f} TON".replace(",", " "))
        if self.supply:
            parts.append(f"{self.supply:,} шт".replace(",", " "))
        if self.rarity:
            parts.append(f"{self.rarity}‰")
        return " · ".join(parts)


def rank(name: str, query: str) -> float:
    """Оценка совпадения: ищем по любым словам, не обязательно с начала строки."""
    text = str(name).lower()
    query = query.lower().strip()
    if not query:
        return 1.0
    words = re.split(r"[\s\-/]+", text)
    score = 0.0
    for token in query.split():
        if text.startswith(token):
            score += 100
        elif any(word.startswith(token) for word in words):
            score += 70
        elif token in text:
            score += 40
        else:
            ratio = max(
                [difflib.SequenceMatcher(None, token, word).ratio() for word in words] or [0]
            )
            if ratio >= 0.72:
                score += 25 * ratio
            else:
                return -1.0
    return score - len(text) * 0.01


class GiftCatalog:
    """Справочник подарков поверх data.json + публичных роутов Portals."""

    def __init__(self, config: Config | None = None, portals: PortalsClient | None = None) -> None:
        self.config = config or Config.load()
        self.portals = portals or PortalsClient()
        self.root = self.config.session_path.parent
        self.data_path = self.root / "data.json"
        self.images_dir = self.root / "downloaded_collections"
        self.thumbs_dir = self.config.cache_dir / "thumbs"
        self.thumbs_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._session: requests.Session | None = None
        self.data: dict = {"collections": {}, "floor_prices": {}, "meta": {}}
        self.backdrop_colors: dict[str, dict] = {}
        self._load()

    # ------------------------------------------------------------------ файлы
    def _load(self) -> None:
        if self.data_path.exists():
            try:
                self.data = json.loads(self.data_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
        self.data.setdefault("collections", {})
        self.data.setdefault("floor_prices", {})
        self.data.setdefault("meta", {})

        colors_path = Path(__file__).with_name("backdrops.json")
        if colors_path.exists():
            try:
                self.backdrop_colors = json.loads(colors_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                self.backdrop_colors = {}

    def save(self) -> None:
        tmp = self.data_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.data_path)

    def _http(self) -> requests.Session:
        if self._session is None:
            self._session = new_session(self.config.request_timeout)
        return self._session

    # ------------------------------------------------------------- коллекции
    def collections(self) -> list[CollectionInfo]:
        meta = self.data.get("meta") or {}
        result = []
        for short, block in meta.items():
            result.append(
                CollectionInfo(
                    short_name=short,
                    name=block.get("name") or short,
                    id=block.get("id"),
                    floor=to_float(block.get("floor_price")) or None,
                    supply=block.get("supply"),
                    listed=block.get("listed_count"),
                    volume=to_float(block.get("volume")) or None,
                    day_volume=to_float(block.get("day_volume")) or None,
                    photo_url=block.get("photo_url"),
                    is_new=bool(block.get("is_new")),
                )
            )
        if not result:
            # meta ещё не собрана — показываем хотя бы то, что есть в data.json
            for short in self.data.get("collections", {}):
                result.append(CollectionInfo(short_name=short, name=short))
        result.sort(key=lambda c: (-(c.volume or 0), c.name))
        return result

    def collection(self, name_or_short: str) -> CollectionInfo | None:
        if not name_or_short:
            return None
        target = str(name_or_short).strip().lower()
        flat = slugify(target)
        for info in self.collections():
            if info.name.lower() == target or info.short_name.lower() == target:
                return info
            if slugify(info.name) == flat or info.short_name == flat:
                return info
        return None

    def search_collections(self, query: str, limit: int = 60) -> list[CollectionInfo]:
        items = self.collections()
        if not query.strip():
            return items[:limit]
        scored = []
        for info in items:
            score = max(rank(info.name, query), rank(info.short_name, query))
            if score >= 0:
                scored.append((score, info))
        scored.sort(key=lambda pair: (-pair[0], pair[1].name))
        return [info for _, info in scored[:limit]]

    # ------------------------------------------------------------- атрибуты
    def attributes(self, collection: str, kind: str) -> list[AttrInfo]:
        info = self.collection(collection)
        if info is None:
            return []
        short = info.short_name
        block = (self.data.get("collections") or {}).get(short) or {}
        floors = ((self.data.get("floor_prices") or {}).get(short) or {}).get(kind) or {}
        result = []
        for item in block.get(kind) or []:
            name = item.get("name")
            if not name:
                continue
            result.append(
                AttrInfo(
                    name=str(name),
                    kind=kind,
                    collection=short,
                    floor=to_float(item.get("floor_price") or floors.get(name)) or None,
                    supply=item.get("supply"),
                    rarity=item.get("rarity_per_mille") or item.get("rarityPermille"),
                    url=item.get("url") or self.attr_url(short, kind, str(name)),
                    colors=self.backdrop_colors.get(str(name)) if kind == "backdrops" else None,
                )
            )
        result.sort(key=lambda a: (a.floor is None, -(a.floor or 0), a.name))
        return result

    def search_attributes(
        self, collection: str, kind: str, query: str, limit: int = 80
    ) -> list[AttrInfo]:
        items = self.attributes(collection, kind)
        if not query.strip():
            return items[:limit]
        scored = [(rank(item.name, query), item) for item in items]
        scored = [pair for pair in scored if pair[0] >= 0]
        scored.sort(key=lambda pair: (-pair[0], pair[1].name))
        return [item for _, item in scored[:limit]]

    # -------------------------------------------------------------- картинки
    def attr_url(self, short: str, kind: str, name: str) -> str | None:
        if kind not in KIND_DIR:
            return None
        return f"{STORAGE}/{short}/{KIND_DIR[kind]}/{slugify(name)}.png"

    def local_image(self, short: str, name: str) -> Path | None:
        """Картинка из downloaded_collections (main.py складывает их именно так)."""
        folder = self.images_dir / short
        if not folder.exists():
            return None
        for candidate in (safe_filename(name), str(name), slugify(name)):
            path = folder / f"{candidate}.png"
            if path.exists():
                return path
        return None

    def image(self, collection: str, kind: str, name: str, download: bool = True) -> Path | None:
        """Локальная картинка модели/символа; при необходимости скачивает её."""
        info = self.collection(collection)
        short = info.short_name if info else slugify(collection)
        if kind == "backdrops":
            return None
        local = self.local_image(short, name)
        if local or not download:
            return local
        url = self.attr_url(short, kind, name)
        if not url:
            return None
        folder = self.images_dir / short
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"{safe_filename(name)}.png"
        return self._download(url, target)

    def collection_icon(self, collection: str, download: bool = True) -> Path | None:
        """Иконка коллекции: первая локальная модель, иначе photo_url из Portals."""
        info = self.collection(collection)
        if info is None:
            return None
        short = info.short_name
        cached = self.thumbs_dir / f"{short}.png"
        if cached.exists():
            return cached
        folder = self.images_dir / short
        if folder.exists():
            files = sorted(folder.glob("*.png"))
            if files:
                return files[0]
        if not download:
            return None
        url = info.photo_url
        if not url:
            models = self.attributes(short, "models")
            url = models[0].url if models else None
        if not url:
            return None
        return self._download(url, cached)

    def _download(self, url: str, target: Path) -> Path | None:
        try:
            response = self._http().get(url, timeout=self.config.request_timeout)
            if response.status_code != 200 or not response.content:
                return None
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(response.content)
            return target
        except Exception:  # noqa: BLE001 - картинка не критична
            return None

    def backdrop_color(self, name: str | None) -> dict | None:
        if not name:
            return None
        return self.backdrop_colors.get(str(name))

    # ------------------------------------------------------------- обновление
    def refresh(self, on_progress=None, batch: int = 10) -> dict:
        """Дотягивает data.json до полного списка коллекций Portals."""

        def progress(text: str) -> None:
            if on_progress:
                on_progress(text)

        with self._lock:
            progress("Portals: список коллекций…")
            collections = self.portals.collections(refresh=True)
            meta = self.data.setdefault("meta", {})
            for item in collections:
                short = item.get("short_name")
                if not short:
                    continue
                meta[short] = {
                    "name": item.get("name") or short,
                    "id": item.get("id"),
                    "photo_url": item.get("photo_url") or "",
                    "floor_price": item.get("floor_price"),
                    "supply": item.get("supply"),
                    "listed_count": item.get("listed_count"),
                    "volume": item.get("volume"),
                    "day_volume": item.get("day_volume"),
                    "is_new": item.get("is_new"),
                }

            shorts = [c.get("short_name") for c in collections if c.get("short_name")]
            added = 0
            for index in range(0, len(shorts), batch):
                chunk = shorts[index : index + batch]
                progress(f"Атрибуты {index + len(chunk)}/{len(shorts)}…")
                try:
                    data = self.portals._call(
                        "/collections/filters",
                        {"short_names": ",".join(chunk)},
                        need_auth=False,
                    )
                except Exception as exc:  # noqa: BLE001
                    progress(f"пропуск {chunk[0]}…: {exc}")
                    continue
                blocks = (data or {}).get("collections") or {}
                for short, block in blocks.items():
                    if not short:
                        continue
                    known = self.data["collections"].get(short)
                    if known is None:
                        added += 1
                    self.data["collections"][short] = {
                        "models": self._clean(block.get("models"), short, "models"),
                        "symbols": self._clean(block.get("symbols"), short, "symbols"),
                        "backdrops": self._clean(block.get("backdrops"), short, "backdrops"),
                    }
                    self.data["floor_prices"][short] = {
                        kind: {
                            item.get("name"): item.get("floor_price")
                            for item in (block.get(kind) or [])
                            if item.get("name") and item.get("floor_price")
                        }
                        for kind in KINDS
                    }
                time.sleep(0.1)

            self.data["updated_at"] = time.time()
            self.save()
            progress(f"Готово: {len(self.data['collections'])} коллекций (+{added})")
            return {"collections": len(self.data["collections"]), "added": added}

    def _clean(self, items, short: str, kind: str) -> list[dict]:
        out = []
        for item in items or []:
            name = item.get("name")
            if not name:
                continue
            row = {
                "name": name,
                "url": item.get("url") or (self.attr_url(short, kind, name) or ""),
                "collection": short,
            }
            rarity = item.get("rarity_per_mille", item.get("rarityPermille"))
            if rarity is not None:
                row["rarity_per_mille"] = rarity
            if item.get("floor_price"):
                row["floor_price"] = item["floor_price"]
            if item.get("supply") is not None:
                row["supply"] = item["supply"]
            if kind == "backdrops":
                colors = self.backdrop_colors.get(str(name))
                if colors:
                    row["colors"] = colors
                row.pop("url", None)
            out.append(row)
        return out

    def download_images(self, collection: str | None = None, on_progress=None) -> dict:
        """Догружает недостающие картинки моделей и символов."""
        targets = (
            [self.collection(collection)] if collection else self.collections()
        )
        done = 0
        skipped = 0
        for info in targets:
            if info is None:
                continue
            for kind in ("models", "symbols"):
                for attr in self.attributes(info.short_name, kind):
                    if self.local_image(info.short_name, attr.name):
                        skipped += 1
                        continue
                    if self.image(info.short_name, kind, attr.name):
                        done += 1
                        if on_progress and done % 10 == 0:
                            on_progress(f"{info.name}: скачано {done}")
        return {"downloaded": done, "already": skipped}

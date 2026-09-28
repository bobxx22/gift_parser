"""Конфигурация: чтение .env, пути, описание mini apps."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# Python-версия лежит в legacy-python/, а данные (.env, data.json, картинки,
# файл сессии) остались в корне проекта — на уровень выше.
PACKAGE_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = PACKAGE_DIR.parent if (PACKAGE_DIR.parent / "data.json").exists() else PACKAGE_DIR
ENV_PATH = PROJECT_DIR / ".env"
CACHE_DIR = PROJECT_DIR / ".cache"
SESSION_PATH = PROJECT_DIR / "tg_session"


def load_env(path: Path = ENV_PATH) -> dict[str, str]:
    """Читает .env. Поддерживает и `KEY=VALUE`, и `KEY: VALUE`."""
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.lower().startswith("export "):
            line = line[7:].strip()
        for sep in ("=", ":"):
            if sep in line:
                key, _, value = line.partition(sep)
                values[key.strip().upper()] = value.strip().strip("'\"")
                break
    return values


@dataclass(frozen=True)
class MiniApp:
    """Мини-апп маркетплейса внутри Telegram."""

    key: str
    bot: str
    short_name: str | None = None
    main: bool = False


MINI_APPS: dict[str, MiniApp] = {
    # t.me/mrkt — главный mini app бота (открывается прямо по ссылке на бота)
    "mrkt": MiniApp(key="mrkt", bot="mrkt", short_name="app", main=True),
    # t.me/portals_market_bot/market
    "portals": MiniApp(key="portals", bot="portals_market_bot", short_name="market"),
    # t.me/tonnel_network_bot — marketplace.tonnel.network
    "tonnel": MiniApp(key="tonnel", bot="tonnel_network_bot", short_name="gifts", main=True),
}


@dataclass(frozen=True)
class Config:
    api_id: int
    api_hash: str
    session_path: Path = SESSION_PATH
    cache_dir: Path = CACHE_DIR
    # Сколько живёт закешированная initData до перевыпуска (сек).
    init_data_ttl: int = 40 * 60
    request_timeout: int = 25

    @classmethod
    def load(cls) -> "Config":
        env = load_env()
        api_id = os.environ.get("TG_API_ID") or env.get("API_ID") or env.get("TG_API_ID")
        api_hash = os.environ.get("TG_API_HASH") or env.get("API_HASH") or env.get("TG_API_HASH")
        if not api_id or not api_hash:
            raise RuntimeError(
                "Не найдены API_ID / API_HASH. Укажи их в файле .env рядом с проектом:\n"
                "API_ID=12345678\nAPI_HASH=abcdef...\n"
                "(получить можно на https://my.telegram.org -> API development tools)"
            )
        cls_cache = CACHE_DIR
        cls_cache.mkdir(parents=True, exist_ok=True)
        return cls(api_id=int(str(api_id).strip()), api_hash=str(api_hash).strip())

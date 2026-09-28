"""Получение initData мини-аппов через Telethon.

Оба маркетплейса авторизуют по Telegram WebApp initData:
  * MRKT     - POST /api/v1/auth {"data": <initData>} -> token, дальше `Authorization: <token>`
  * Portals  - заголовок `Authorization: tma <initData>` напрямую

initData выпускает сам Telegram, когда клиент "открывает" мини-апп
(messages.requestMainWebView / messages.requestAppWebView). Telethon делает ровно это.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

from telethon import TelegramClient, utils
from telethon.tl.functions.messages import (
    RequestAppWebViewRequest,
    RequestWebViewRequest,
)
from telethon.tl.types import InputBotAppShortName

try:  # есть в Telethon >= 1.36
    from telethon.tl.functions.messages import RequestMainWebViewRequest
except ImportError:  # pragma: no cover
    RequestMainWebViewRequest = None  # type: ignore[assignment]

from .config import MINI_APPS, Config, MiniApp

# Притворяемся обычным мобильным клиентом: мини-аппы отдают для web-платформы
# другой набор данных и чаще требуют дополнительных подтверждений.
DEVICE = {
    "device_model": "Samsung SM-G998B",
    "system_version": "Android 13 (SDK 33)",
    "app_version": "11.5.0",
    "lang_code": "ru",
    "system_lang_code": "ru-RU",
}
PLATFORM = "android"


class AuthError(RuntimeError):
    pass


class NotLoggedIn(AuthError):
    def __init__(self) -> None:
        super().__init__(
            "Telegram-сессия не создана. Выполни в терминале:  python cli.py login"
        )


@dataclass
class _CacheEntry:
    init_data: str
    ts: float


def _extract_init_data(url: str) -> str:
    """Достаёт tgWebAppData из фрагмента URL мини-аппа."""
    fragment = urllib.parse.urlparse(url).fragment
    for part in fragment.split("&"):
        key, _, value = part.partition("=")
        if key == "tgWebAppData":
            # unquote, а не unquote_plus: "+" в подписи не должен превратиться в пробел
            return urllib.parse.unquote(value)
    raise AuthError("В ответе Telegram нет tgWebAppData: " + url[:120])


class TelegramAuth:
    """Выдаёт (и кеширует на диск) initData для мини-аппов."""

    def __init__(self, config: Config | None = None) -> None:
        self.config = config or Config.load()
        self._lock = threading.Lock()
        self._cache_path: Path = self.config.cache_dir / "init_data.json"
        self._memory: dict[str, _CacheEntry] = {}
        self._load_cache()

    # ------------------------------------------------------------------ cache
    def _load_cache(self) -> None:
        if not self._cache_path.exists():
            return
        try:
            raw = json.loads(self._cache_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return
        for key, item in raw.items():
            try:
                self._memory[key] = _CacheEntry(item["init_data"], float(item["ts"]))
            except (KeyError, TypeError, ValueError):
                continue

    def _save_cache(self) -> None:
        payload = {k: {"init_data": v.init_data, "ts": v.ts} for k, v in self._memory.items()}
        self._cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._cache_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        tmp.replace(self._cache_path)

    # -------------------------------------------------------------------- api
    def is_logged_in(self) -> bool:
        async def check() -> bool:
            client = self._client()
            await client.connect()
            try:
                return await client.is_user_authorized()
            finally:
                await client.disconnect()

        with self._lock:
            return asyncio.run(check())

    def whoami(self) -> str:
        async def me() -> str:
            client = self._client()
            await client.connect()
            try:
                if not await client.is_user_authorized():
                    raise NotLoggedIn()
                user = await client.get_me()
                name = " ".join(filter(None, [user.first_name, user.last_name]))
                handle = user.username or user.id
                return f"{name} (@{handle})"
            finally:
                await client.disconnect()

        with self._lock:
            return asyncio.run(me())

    def run(self, coro_factory):
        """Выполняет корутину с подключённым клиентом: run(lambda client: ...)."""

        async def wrapper():
            client = self._client()
            await client.connect()
            try:
                if not await client.is_user_authorized():
                    raise NotLoggedIn()
                return await coro_factory(client)
            finally:
                await client.disconnect()

        with self._lock:
            return asyncio.run(wrapper())

    def init_data(self, app_key: str, force: bool = False) -> str:
        """initData для мини-аппа (`mrkt` / `portals`), с кешем на диске."""
        app = MINI_APPS[app_key]
        cached = self._memory.get(app_key)
        if cached and not force and time.time() - cached.ts < self.config.init_data_ttl:
            return cached.init_data

        with self._lock:
            cached = self._memory.get(app_key)
            if cached and not force and time.time() - cached.ts < self.config.init_data_ttl:
                return cached.init_data
            init_data = asyncio.run(self._fetch(app))
            self._memory[app_key] = _CacheEntry(init_data, time.time())
            self._save_cache()
            return init_data

    def login(self, phone: str | None = None) -> str:
        """Интерактивный вход: код из Telegram и пароль 2FA вводит сам пользователь."""

        async def do_login() -> str:
            client = self._client()
            if phone:
                await client.start(phone=phone)
            else:
                await client.start()
            try:
                user = await client.get_me()
                name = " ".join(filter(None, [user.first_name, user.last_name]))
                return f"{name} (@{user.username or user.id})"
            finally:
                await client.disconnect()

        with self._lock:
            return asyncio.run(do_login())

    def logout(self) -> None:
        async def do_logout() -> None:
            client = self._client()
            await client.connect()
            try:
                if await client.is_user_authorized():
                    await client.log_out()
            finally:
                await client.disconnect()

        with self._lock:
            asyncio.run(do_logout())
        self._memory.clear()
        if self._cache_path.exists():
            self._cache_path.unlink()

    # --------------------------------------------------------------- internals
    def _client(self) -> TelegramClient:
        return TelegramClient(
            str(self.config.session_path),
            self.config.api_id,
            self.config.api_hash,
            **DEVICE,
        )

    async def _fetch(self, app: MiniApp) -> str:
        client = self._client()
        await client.connect()
        try:
            if not await client.is_user_authorized():
                raise NotLoggedIn()
            peer = await client.get_input_entity(app.bot)
            bot_user = utils.get_input_user(peer)

            builders = []
            if app.main and RequestMainWebViewRequest is not None:
                builders.append(
                    lambda: RequestMainWebViewRequest(
                        peer=peer, bot=bot_user, platform=PLATFORM
                    )
                )
            if app.short_name:
                builders.append(
                    lambda: RequestAppWebViewRequest(
                        peer=peer,
                        app=InputBotAppShortName(bot_id=bot_user, short_name=app.short_name),
                        platform=PLATFORM,
                        write_allowed=True,
                    )
                )
            builders.append(
                lambda: RequestWebViewRequest(
                    peer=peer, bot=bot_user, platform=PLATFORM, from_bot_menu=True
                )
            )

            errors: list[str] = []
            for build in builders:
                request = build()
                try:
                    result = await client(request)
                except Exception as exc:  # noqa: BLE001 - пробуем следующий способ
                    errors.append(f"{type(request).__name__}: {exc}")
                    continue
                url = getattr(result, "url", None)
                if not url:
                    errors.append(f"{type(request).__name__}: пустой url")
                    continue
                try:
                    return _extract_init_data(url)
                except AuthError as exc:
                    errors.append(str(exc))
            raise AuthError(f"Не удалось открыть мини-апп @{app.bot}: " + "; ".join(errors))
        finally:
            await client.disconnect()


def parse_init_data(init_data: str) -> dict[str, str]:
    """Разбирает initData в словарь (для отладки)."""
    return dict(urllib.parse.parse_qsl(init_data, keep_blank_values=True))

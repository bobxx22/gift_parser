"""Картинки для интерфейса: миниатюры, свотчи фонов, карточка подарка."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageTk

_CACHE: dict[tuple, ImageTk.PhotoImage] = {}
_PIL_CACHE: dict[tuple, Image.Image] = {}


def _rgb(value: int | None) -> tuple[int, int, int]:
    if not value:
        return (60, 64, 78)
    return ((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF)


def rgb_hex(value: int | None) -> str:
    red, green, blue = _rgb(value)
    return f"#{red:02x}{green:02x}{blue:02x}"


def _rounded(image: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, image.size[0] - 1, image.size[1] - 1],
                                           radius=radius, fill=255)
    out = image.copy()
    out.putalpha(mask)
    return out


def backdrop_image(colors: dict | None, size: int) -> Image.Image:
    """Радиальный градиент фона подарка (цвета приходят из Telegram)."""
    key = ("backdrop", colors.get("center") if colors else None,
           colors.get("edge") if colors else None, size)
    cached = _PIL_CACHE.get(key)
    if cached is not None:
        return cached
    center = _rgb((colors or {}).get("center"))
    edge = _rgb((colors or {}).get("edge"))
    image = Image.new("RGB", (size, size), edge)
    pixels = image.load()
    half = size / 2
    longest = math.hypot(half, half)
    for y in range(size):
        for x in range(size):
            distance = min(math.hypot(x - half, y - half) / longest, 1.0)
            pixels[x, y] = tuple(
                int(center[i] + (edge[i] - center[i]) * distance) for i in range(3)
            )
    _PIL_CACHE[key] = image
    return image


def gift_image(model_path: Path | None, colors: dict | None, size: int = 120) -> Image.Image:
    """Модель подарка на её фоне — как карточка в Telegram."""
    key = ("gift", str(model_path), colors.get("center") if colors else None, size)
    cached = _PIL_CACHE.get(key)
    if cached is not None:
        return cached
    canvas = backdrop_image(colors, size).convert("RGBA")
    if model_path and Path(model_path).exists():
        try:
            model = Image.open(model_path).convert("RGBA")
            box = int(size * 0.82)
            model.thumbnail((box, box), Image.Resampling.LANCZOS)
            offset = ((size - model.size[0]) // 2, (size - model.size[1]) // 2)
            canvas.alpha_composite(model, offset)
        except Exception:  # noqa: BLE001 - картинка не критична
            pass
    canvas = _rounded(canvas, radius=max(6, size // 8))
    _PIL_CACHE[key] = canvas
    return canvas


def photo(image: Image.Image, key: tuple) -> ImageTk.PhotoImage:
    cached = _CACHE.get(key)
    if cached is None:
        cached = ImageTk.PhotoImage(image)
        _CACHE[key] = cached
    return cached


def thumb_photo(path: Path | None, size: int = 34, colors: dict | None = None):
    """Миниатюра для списка: картинка модели либо свотч фона."""
    key = ("thumb", str(path), size, colors.get("center") if colors else None)
    cached = _CACHE.get(key)
    if cached is not None:
        return cached
    if path and Path(path).exists():
        try:
            image = Image.open(path).convert("RGBA")
            image.thumbnail((size, size), Image.Resampling.LANCZOS)
            canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            canvas.alpha_composite(
                image, ((size - image.size[0]) // 2, (size - image.size[1]) // 2)
            )
        except Exception:  # noqa: BLE001
            return None
    elif colors:
        canvas = _rounded(backdrop_image(colors, size).convert("RGBA"), radius=size // 3)
    else:
        return None
    result = ImageTk.PhotoImage(canvas)
    _CACHE[key] = result
    return result

"""Консольный интерфейс парсера цен подарков.

    python cli.py login                        # вход в Telegram (код вводишь сам)
    python cli.py probe                        # проверка всех площадок
    python cli.py update-data                  # дотянуть data.json до полного списка
    python cli.py images --collection finepen  # догрузить картинки моделей
    python cli.py collections --filter helmet
    python cli.py attrs "Heroic Helmet"
    python cli.py search "Heroic Helmet" --model "Bengal Tiger" --days 90
    python cli.py rates                        # курс TON/USD и пересчёт в звёзды
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from gift_parser.markets.base import Filters  # noqa: E402
from gift_parser.rates import format_stars, format_usd  # noqa: E402
from gift_parser.service import SOURCES, GiftPriceService, SearchQuery  # noqa: E402
from gift_parser.tg_auth import NotLoggedIn  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

DEFAULT_SOURCES = "mrkt,portals,fragment,telegram,tonnel"


def _fmt(value: float | None, digits: int = 2) -> str:
    return "—" if value is None else f"{value:,.{digits}f}".replace(",", " ")


def cmd_login(args: argparse.Namespace) -> int:
    service = GiftPriceService()
    print("Вход в Telegram. Номер, код и (при необходимости) пароль 2FA вводишь ты сам.")
    who = service.auth.login(args.phone)
    print(f"Готово: {who}")
    print(f"Сессия сохранена: {service.config.session_path}.session")
    return 0


def cmd_logout(_: argparse.Namespace) -> int:
    GiftPriceService().auth.logout()
    print("Сессия удалена.")
    return 0


def cmd_whoami(_: argparse.Namespace) -> int:
    try:
        print(GiftPriceService().auth.whoami())
    except NotLoggedIn as exc:
        print(exc)
        return 1
    return 0


def cmd_sources(_: argparse.Namespace) -> int:
    print(f"{'ключ':<10}{'площадка':<12}{'история':<10}{'лоты':<7}{'вход':<7}примечание")
    for source in SOURCES:
        print(
            f"{source.key:<10}{source.title:<12}"
            f"{'да' if source.history else 'нет':<10}"
            f"{'да' if source.listings else 'нет':<7}"
            f"{'нужен' if source.needs_login else 'нет':<7}{source.note}"
        )
    return 0


def cmd_update_data(args: argparse.Namespace) -> int:
    service = GiftPriceService()
    path = service.catalog.data_path
    if path.exists() and not args.no_backup:
        backup = path.with_suffix(".json.bak")
        shutil.copyfile(path, backup)
        print(f"Бэкап: {backup}")
    result = service.catalog.refresh(on_progress=lambda text: print("  ", text, flush=True))
    print(f"Готово: {result['collections']} коллекций, новых {result['added']}")
    return 0


def cmd_images(args: argparse.Namespace) -> int:
    service = GiftPriceService()
    print("Качаю недостающие картинки (модели и символы)…")
    result = service.catalog.download_images(
        args.collection, on_progress=lambda text: print("  ", text, flush=True)
    )
    print(f"Скачано: {result['downloaded']}, уже было: {result['already']}")
    return 0


def cmd_collections(args: argparse.Namespace) -> int:
    service = GiftPriceService()
    items = service.catalog.search_collections(args.filter or "", limit=500)
    for info in items:
        print(f"{info.name:<28}{info.short_name:<20}{info.subtitle}")
    print(f"\nВсего: {len(items)} из {len(service.catalog.collections())}")
    return 0


def cmd_attrs(args: argparse.Namespace) -> int:
    service = GiftPriceService()
    for kind, title in (("models", "Модели"), ("backdrops", "Фоны"), ("symbols", "Символы")):
        items = service.catalog.attributes(args.collection, kind)
        if args.filter:
            items = service.catalog.search_attributes(args.collection, kind, args.filter)
        print(f"\n{title} ({len(items)}):")
        for item in items[: args.show]:
            print(f"  {item.name:<28}{item.subtitle}")
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    service = GiftPriceService()
    sources = tuple(x.strip() for x in (args.sources or DEFAULT_SOURCES).split(",") if x.strip())
    query = SearchQuery(
        collection=args.collection,
        model=args.model,
        backdrop=args.backdrop,
        symbol=args.symbol,
        days=None if args.days == 0 else args.days,
        sources=sources,
        only_sales=not args.all_events,
        limit=args.limit,
    )
    result = service.search(query, on_progress=lambda text: print(f"  ... {text}", flush=True))

    print(f"\n=== {query.title} ===")
    for name, error in result.errors.items():
        print(f"  [!] {name}: {error}")

    stats = result.stats
    if stats.empty:
        print("Продаж не найдено.")
    else:
        print(
            f"\nПродаж: {stats.count}   "
            + "   ".join(f"{market}: {count}" for market, count in stats.per_market.items())
        )
        rates = service.rates
        try:
            rates.refresh()
        except Exception as exc:  # noqa: BLE001
            print(f"  [!] курс TON: {exc}")

        def money(ton, moment=None) -> str:
            usd = rates.usd(ton, moment)
            stars = rates.stars(ton, moment)
            if usd is None:
                return ""
            return f"  = {format_usd(usd)} = {format_stars(stars)}"

        print(f"Медиана:        {_fmt(stats.median)} TON{money(stats.median)}")
        print(f"Средняя:        {_fmt(stats.average)} TON  (без выбросов {_fmt(stats.trimmed_average)})")
        print(f"Мин / Макс:     {_fmt(stats.minimum)} / {_fmt(stats.maximum)} TON")
        print(f"25% / 75%:      {_fmt(stats.p25)} / {_fmt(stats.p75)} TON")
        print(f"Последняя:      {_fmt(stats.last_price)} TON  "
              f"({stats.last_ts:%Y-%m-%d %H:%M} UTC){money(stats.last_price, stats.last_ts)}")
        print(f"Средняя из 5:   {_fmt(stats.avg_last5)} TON")
    for market, floor in sorted(result.floors.items()):
        extra = ""
        try:
            usd = service.rates.usd(floor)
            if usd:
                extra = f"  = {format_usd(usd)} = {format_stars(service.rates.stars(floor))}"
        except Exception:  # noqa: BLE001
            pass
        print(f"Флор {market}: {_fmt(floor)} TON{extra}")
    if result.official:
        info = result.official
        currency = info.get("currency") or ""
        print(
            f"Оценка Telegram: {_fmt(info.get('average'))} {currency} "
            f"(флор {_fmt(info.get('floor'))}, лотов {info.get('listed_count')})"
        )

    rows = result.events[: args.show]
    if rows:
        print(f"\n{'Дата (UTC)':<18}{'Площадка':<11}{'Событие':<13}{'Цена':>10}  Подарок")
        for event in rows:
            gift = event.gift_name or f"#{event.number}"
            attrs = event.attrs
            print(
                f"{event.ts:%Y-%m-%d %H:%M}  {event.market:<11}{event.kind:<13}"
                f"{_fmt(event.price):>10}  {gift} {('· ' + attrs) if attrs else ''}"
            )
    if args.csv:
        print(f"\nCSV: {result.to_csv(Path(args.csv))}")
    print(f"\nГотово за {result.elapsed:.1f} с")
    return 0


def cmd_rates(args: argparse.Namespace) -> int:
    service = GiftPriceService()
    rates = service.rates
    added = rates.refresh(force=args.force, on_progress=lambda text: print("  ", text))
    days = sorted(rates.prices)
    print(f"Источник: {rates.source} | дней: {len(days)} (+{added})")
    if days:
        print(f"Период:   {days[0]} … {days[-1]}")
        low = min(rates.prices.values())
        high = max(rates.prices.values())
        print(f"Курс TON: мин {format_usd(low)}  макс {format_usd(high)}  "
              f"сейчас {format_usd(rates.spot_price())}")
    print(f"Файл:     {rates.path}")
    from gift_parser.rates import STAR_BUY_USD, STAR_SELL_USD
    print(f"1 {'★'}:      покупка ${STAR_BUY_USD:.4f} · продажа ${STAR_SELL_USD:.4f}")
    for ton in (1, 10, 100):
        print(f"  {ton:>4} TON = {format_usd(rates.usd(ton))} = {format_stars(rates.stars(ton))}")
    return 0


def cmd_probe(_: argparse.Namespace) -> int:
    service = GiftPriceService()
    filters = Filters(collection="Heroic Helmet")

    print("1) Каталог")
    collections = service.catalog.collections()
    print(f"   data.json: {len(collections)} коллекций")

    print("2) Telegram-сессия")
    logged = service.is_logged_in()
    print(f"   {'есть' if logged else 'нет (python cli.py login)'}")

    checks = [
        ("Portals", lambda: len(service.portals.collection_names()), "коллекций"),
        ("Fragment", lambda: len(service.fragment.history(filters, limit=60)), "сделок"),
    ]
    if logged:
        checks += [
            ("MRKT", lambda: len(service.mrkt.history(filters, limit=20)), "сделок"),
            ("Portals история", lambda: len(service.portals.history(filters, limit=20)), "сделок"),
            ("Telegram", lambda: len(service.telegram.listings(filters, limit=5)), "лотов"),
        ]
    checks.append(("Tonnel", lambda: len(service.tonnel.listings(filters, limit=5)), "лотов"))

    print("3) Площадки")
    failed = 0
    for title, call, unit in checks:
        try:
            print(f"   {title:<18} ok: {call()} {unit}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"   {title:<18} ОШИБКА: {str(exc)[:120]}")
    return 1 if failed else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Парсер цен подарков Telegram")
    sub = parser.add_subparsers(dest="command", required=True)

    login = sub.add_parser("login", help="вход в Telegram")
    login.add_argument("--phone")
    login.set_defaults(func=cmd_login)

    sub.add_parser("logout", help="удалить сессию").set_defaults(func=cmd_logout)
    sub.add_parser("whoami", help="кто залогинен").set_defaults(func=cmd_whoami)
    sub.add_parser("sources", help="список площадок").set_defaults(func=cmd_sources)
    sub.add_parser("probe", help="проверить площадки").set_defaults(func=cmd_probe)

    rates = sub.add_parser("rates", help="курс TON/USD и цены в звёздах")
    rates.add_argument("--force", action="store_true", help="перекачать историю заново")
    rates.set_defaults(func=cmd_rates)

    update = sub.add_parser("update-data", help="обновить data.json из Portals")
    update.add_argument("--no-backup", action="store_true")
    update.set_defaults(func=cmd_update_data)

    images = sub.add_parser("images", help="догрузить картинки")
    images.add_argument("--collection")
    images.set_defaults(func=cmd_images)

    collections = sub.add_parser("collections", help="список коллекций")
    collections.add_argument("--filter")
    collections.set_defaults(func=cmd_collections)

    attrs = sub.add_parser("attrs", help="модели/фоны/символы коллекции")
    attrs.add_argument("collection")
    attrs.add_argument("--filter")
    attrs.add_argument("--show", type=int, default=25)
    attrs.set_defaults(func=cmd_attrs)

    search = sub.add_parser("search", help="история продаж подарка")
    search.add_argument("collection")
    search.add_argument("--model")
    search.add_argument("--backdrop")
    search.add_argument("--symbol")
    search.add_argument("--days", type=int, default=90, help="0 = без ограничения")
    search.add_argument("--limit", type=int, default=300)
    search.add_argument("--sources", default=DEFAULT_SOURCES,
                        help=f"через запятую: {', '.join(s.key for s in SOURCES)}")
    search.add_argument("--all-events", action="store_true")
    search.add_argument("--show", type=int, default=25)
    search.add_argument("--csv")
    search.set_defaults(func=cmd_search)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return args.func(args)
    except NotLoggedIn as exc:
        print(f"\n{exc}")
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())

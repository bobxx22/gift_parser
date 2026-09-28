"""Проверка нормализации на реальных ответах API (сэмплы из консоли пользователя)."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gift_parser.markets.base import Filters
from gift_parser.markets.mrkt import MrktClient
from gift_parser.markets.portals import PortalsClient
from gift_parser.stats import compute

MRKT_SAMPLE = json.loads(r"""
{"items":[
 {"type":"change_price","id":"1c9434d1","gift":{"id":"c8a5d538","backdropName":"Black","modelName":"Red Lipstick","symbolName":"Pyramid","name":"FinePen-4260","number":4260,"title":"Fine Pen","collectionName":"Fine Pen","salePrice":357000000000,"modelTitle":"Red Lipstick","collectionTitle":"Fine Pen"},"amount":357000000000,"date":"2026-09-05T08:23:27.882252Z"},
 {"type":"sale","id":"f204644f","gift":{"id":"a17f8332","backdropName":"Black","modelName":"Heart Key","symbolName":"Paper Lantern","name":"FinePen-23880","number":23880,"title":"Fine Pen","collectionName":"Fine Pen","salePrice":125000000000},"amount":125000000000,"date":"2026-09-05T08:23:20.846654Z"},
 {"type":"sale","id":"d3685381","gift":{"id":"2160bbc8","backdropName":"Black","modelName":"Lotus Lines","symbolName":"Ramen","name":"FinePen-5445","number":5445,"title":"Fine Pen","collectionName":"Fine Pen","salePrice":76000000000},"amount":76000000000,"date":"2026-09-04T20:38:25.3951739Z"},
 {"type":"listing","id":"0e8e5700","gift":{"id":"e3d1f801","backdropName":"Black","modelName":"Survivalist","symbolName":"Love Letter","name":"FinePen-9156","number":9156,"title":"Fine Pen","collectionName":"Fine Pen","salePrice":306000000000},"amount":239700000000,"date":"2026-09-05T07:54:48.997028Z"}
],"cursor":"bb9313be"}
""")

PORTALS_SAMPLE = json.loads(r"""
{"actions":[
 {"nft":{"id":"c9ee8c37","name":"Heroic Helmet","collection_id":"013a775d","external_collection_number":1194,"status":"withdrawn","tg_id":"HeroicHelmet-1194","attributes":[{"type":"model","value":"Bounty Hunter","rarity_per_mille":1.5},{"type":"symbol","value":"Owl","rarity_per_mille":0.4},{"type":"backdrop","value":"Black","rarity_per_mille":1.5}],"floor_price":"174.789999995"},"type":"listing","amount":"2400","created_at":"2026-07-07T23:16:42.678979Z"},
 {"nft":{"id":"c9ee8c37","name":"Heroic Helmet","external_collection_number":1194,"attributes":[{"type":"model","value":"Bounty Hunter"},{"type":"backdrop","value":"Black"},{"type":"symbol","value":"Owl"}]},"type":"price_update","amount":"2500","old_price":"2000","created_at":"2026-07-07T23:02:36.395806Z"},
 {"nft":{"id":"be66d9cc","name":"Heroic Helmet","external_collection_number":1249,"attributes":[{"type":"model","value":"Biker Warrior"},{"type":"backdrop","value":"Black"},{"type":"symbol","value":"Celtic Wolf"}]},"type":"purchase","amount":"1800","created_at":"2026-05-27T18:38:26.86545Z"}
]}
""")


def main() -> None:
    mrkt = MrktClient.__new__(MrktClient)
    portals = PortalsClient.__new__(PortalsClient)

    print("--- MRKT ---")
    mrkt_events = [mrkt._to_event(item) for item in MRKT_SAMPLE["items"]]
    for event in mrkt_events:
        print(f"  {event.ts:%Y-%m-%d %H:%M}  {event.kind:<12} {event.price:>8.2f} TON  "
              f"{event.model} / {event.backdrop} / {event.symbol}  {event.link}")
    assert mrkt_events[1].price == 125.0, mrkt_events[1].price
    assert mrkt_events[1].kind == "sale"
    assert mrkt_events[0].kind == "price_update"
    assert mrkt_events[3].price == 239.7  # amount, а не salePrice
    assert mrkt_events[2].ts.year == 2026  # 7 знаков в долях секунды

    print("--- Portals ---")
    portals_events = [portals._to_event(item) for item in PORTALS_SAMPLE["actions"]]
    for event in portals_events:
        print(f"  {event.ts:%Y-%m-%d %H:%M}  {event.kind:<12} {event.price:>8.2f} TON  "
              f"{event.model} / {event.backdrop} / {event.symbol}  {event.link}")
    assert portals_events[0].price == 2400.0
    assert portals_events[2].kind == "sale" and portals_events[2].is_sale
    assert portals_events[1].old_price == 2000.0
    assert portals_events[0].link == "https://t.me/nft/HeroicHelmet-1194"
    assert portals_events[2].link == "https://t.me/nft/HeroicHelmet-1249"  # без tg_id

    print("--- Фильтры ---")
    flt = Filters(collection="Heroic Helmet", model="Bounty Hunter", backdrop="Black")
    assert flt.matches(portals_events[0])
    assert not flt.matches(portals_events[2])
    assert Filters(collection="fine pen").matches(mrkt_events[0])

    print("--- Статистика ---")
    sales = [e for e in mrkt_events + portals_events if e.is_sale]
    stats = compute(sales)
    print(f"  count={stats.count} median={stats.median:.2f} avg={stats.average:.2f} "
          f"trimmed={stats.trimmed_average:.2f} last={stats.last_price:.2f}")
    assert stats.count == 3
    assert stats.per_market == {"MRKT": 2, "Portals": 1}

    print("\nВСЕ ПРОВЕРКИ ПРОШЛИ")


if __name__ == "__main__":
    main()

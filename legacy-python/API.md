# API двух маркетплейсов (разобрано из бандлов мини-аппов)

Всё ниже вытащено из публичных JS-бандлов `cdn.tgmrkt.io` и `portal-market.com`
(имена функций у Portals не минифицированы, у MRKT — минифицированы, но строки роутов целы).

---

## MRKT — `https://api.tgmrkt.io/api/v1`

### Авторизация

```http
POST /api/v1/auth
Content-Type: application/json

{"data": "<initData из Telegram>", "appId": null, "photo": "<photo_url, необязательно>"}
```

Ответ: `{"token": "...", "isFirstTime": false, ...}`.
Дальше **все** запросы идут с заголовком `Authorization: <token>` — без `Bearer`.

Без заголовка `Authorization` edge-слой отвечает `403 GUEST_CAPTCHA_REQUIRED`,
на неверную initData — `403 Forbid 1`.

### История рынка

```http
POST /api/v1/feed
{
  "count": 20,
  "cursor": null,                 // из поля "cursor" предыдущего ответа
  "collectionNames": ["Fine Pen"],
  "modelNames": [],
  "backdropNames": [],
  "number": null,
  "type": ["Sale"],
  "minPrice": null,               // nanoTON
  "maxPrice": null
}
```

Ответ: `{"items": [{"type", "id", "gift": {...}, "amount", "date"}], "cursor": "<id последнего>"}`.

* `type` в **запросе** (enum из бандла): `Sale`, `Listing`, `PremarketSale`, `PremarketListing`,
  `ChangePrice`, `LuckyBuySale`, `LuckyBuy`, `Crafting`, `PlinkoWin`.
* `type` в **ответе** приходит в snake_case: `sale`, `listing`, `change_price`, `unlisting`,
  `return`, `premarket_sale`, `lucky_buy`.
* `amount` — nanoTON (÷ 10⁹ = TON).
* Именно из-за пустого/неполного тела и был `400 Bad Request` в консоли: `count` обязателен.

Смежные роуты:

| Роут | Тело | Что делает |
|------|------|------------|
| `POST /api/v1/feed/gift/{giftId}` | `{count, cursor, ...фильтры, ordering:"Latest", lowToHigh:false, section:"Gifts"}` | история конкретного подарка |
| `GET /api/v1/feed/{eventId}` | — | одно событие |
| `POST /api/v1/gifts-bundles/feed` | `{count, cursor, ...}` | лента бандлов |

### Витрина и справочники

| Роут | Тело / параметры | Что отдаёт |
|------|------------------|------------|
| `POST /api/v1/gifts/saling` | `{count, cursor, collectionNames, modelNames, backdropNames, symbolNames, minPrice, maxPrice, number, giftType:"Upgraded", ordering:"Price", lowToHigh:true, query:null, ...}` | активные лоты (флор = первый при `ordering:"Price"`, `lowToHigh:true`) |
| `POST /api/v1/gifts` | `{isListed, count, cursor, ...фильтры}` | свои подарки |
| `GET  /api/v1/gifts/collections` | — | коллекции |
| `POST /api/v1/gifts/models` | `{"collections": ["Fine Pen"]}` | модели |
| `POST /api/v1/gifts/backdrops` | `{"collections": [...]}` | фоны |
| `POST /api/v1/gifts/symbols` | `{"collections": [...]}` | символы |
| `GET  /api/v1/gift-statistics` | — | общая статистика площадки |
| `GET  /api/v1/me`, `/api/v1/configs`, `/api/v1/balance` | — | профиль, конфиг, баланс |

Значения `ordering`: `None`, `Price`, `ModelRarity`, `BackgroundRarity`, `SymbolRarity`, `Number`.
`giftType`: `Regular`, `Upgraded`.

---

## Portals — `https://portal-market.com/api`

### Авторизация

Отдельного логина нет: initData кладётся прямо в заголовок.

```http
Authorization: tma <initData из Telegram>
x-request-id: <uuid>
```

`431 Request Header Fields Too Large` в консоли — это про размер заголовка вместе с длинным
query-string, а не про авторизацию.

### История рынка (нужен токен)

```http
GET /api/market/actions/?offset=0&limit=20
    &collection_ids=<uuid>
    &filter_by_models=Bounty%20Hunter
    &filter_by_backdrops=Black
    &filter_by_symbols=Owl
    &action_types=buy
    &min_price=&max_price=&sort_by=
```

Ответ: `{"actions": [{"nft": {...}, "type", "amount", "old_price", "created_at"}]}`.

* Массивы в query — через запятую (`filter_by_models=A,B`), это делает их paramsSerializer.
* `action_types`: `buy`, `sell`, `lucky_buy`, `listing`, `price_update`.
* `type` в ответе: `purchase`, `listing`, `price_update`, `unlisting`, `return`.
* `amount` — строка в TON (не nanoTON).
* Пагинация — `offset` (курсора нет).

### Публичные роуты (работают вообще без авторизации)

| Роут | Параметры | Что отдаёт |
|------|-----------|------------|
| `GET /api/collections` | `limit`, `offset` | 120 коллекций: `id`, `name`, `short_name`, `floor_price`, `volume`, `supply`, `listed_count` |
| `GET /api/collections/filters` | `short_names=heroichelmet` | модели/фоны/символы + `floor_price` и `supply` по каждому |
| `GET /api/collections/floors` | — | флор по всем коллекциям сразу |
| `GET /api/nfts/search` | `offset`, `limit`, `collection_ids`, `filter_by_models`, `filter_by_backdrops`, `filter_by_symbols`, `status=listed`, `sort_by=price asc`, `exclude_bundled=true`, `premarket_status` | активные лоты |

`sort_by`: `listed_at desc`, `price asc`, `price desc`, `external_collection_number asc/desc`,
`model_rarity asc/desc`.

Другие полезные (с токеном): `GET /api/nfts/{id}/price/average/detailed`,
`POST /api/nfts/attribute-floors`, `GET /api/collections/{id}/metrics`,
`GET /api/market/volume`, `GET /api/users/actions/`.

---

## Откуда берётся initData

Мини-аппу его выдаёт сам Telegram при открытии. Через Telethon это:

```python
messages.RequestMainWebViewRequest(peer=bot, bot=bot, platform="android")   # t.me/mrkt
messages.RequestAppWebViewRequest(peer=bot, app=InputBotAppShortName(bot, "market"),
                                  platform="android", write_allowed=True)   # t.me/portals_market_bot/market
```

В ответе — URL вида `https://.../#tgWebAppData=<url-encoded initData>&tgWebAppVersion=...`.
Нужен именно `tgWebAppData`, декодированный ровно один раз (см. `gift_parser/tg_auth.py`).

Боты: MRKT — [@mrkt](https://t.me/mrkt), Portals — [@portals_market_bot](https://t.me/portals_market_bot)
(мини-апп `market`).

---

## Fragment — `https://fragment.com` (без авторизации)

Страницы коллекций отдаются сервером уже с данными, парсим HTML:

| URL | Что отдаёт |
|-----|------------|
| `/gifts/<slug>?filter=sold&sort=listed` | проданные, по дате — **история сделок** |
| `/gifts/<slug>?filter=sale&sort=price_asc` | активные лоты (первый = флор) |
| `/gifts/<slug>` (без параметров) | проданные, отсортированные по цене |
| `&query=<текст>` | фильтр по атрибуту (модель / фон / символ) |

`slug` — то же, что `short_name` у Portals (`heroichelmet`, `finepen`).
Карточка в разметке: `<a href="/gift/heroichelmet-2470" class="tm-grid-item">` →
цена в `tm-grid-item-value` (TON), статус в `tm-grid-item-status` (`Sold` / `For sale`),
время сделки в `<time datetime="...">`.

Важно: `query` работает как **один** поисковый запрос, а не как «модель И фон».
`query=Bengal Tiger Black` возвращает пусто. На странице 60 карточек, дальше Fragment
догружает их своим внутренним запросом — глубина истории здесь ограничена 60 сделками.

## Официальный маркет Telegram — MTProto (Telethon >= 1.44)

```python
payments.GetStarGiftsRequest(hash=0)
# -> 151 подарок, у 122 есть title: {title -> gift_id}

payments.GetResaleStarGiftsRequest(gift_id, offset="", limit=50,
                                   sort_by_price=True, attributes=[...], attributes_hash=0)
# -> count, gifts[StarGiftUnique], next_offset, attributes, counters
```

Каждый лот: `slug` (`HeroicHelmet-1415`), `num`, `attributes`
(`StarGiftAttributeModel` / `...Pattern` / `...Backdrop` c именами),
`resell_amount = [StarsAmount(amount=18751), StarsTonAmount(amount=197950000000)]`
— то есть цена сразу в Stars и в нанотонах, `value_amount` / `value_currency` / `value_usd_amount`.

Фильтр по атрибутам — через `attributes=[StarGiftAttributeIdModel(document_id=...),
StarGiftAttributeIdPattern(document_id=...), StarGiftAttributeIdBackdrop(backdrop_id=...)]`.
Список всех атрибутов подарка приходит в том же ответе при `attributes_hash=0`
(для Heroic Helmet: 49 моделей, 187 символов, 78 фонов) — у фонов там же лежат
`center_color` / `edge_color` / `pattern_color` / `text_color`, из них рисуется карточка.

```python
payments.GetUniqueStarGiftValueInfoRequest(slug="HeroicHelmet-1349")
# -> floor_price, average_price, last_sale_price/date, initial_sale_price/date,
#    listed_count, fragment_listed_count, currency (валюта аккаунта, суммы в сотых)
```

Истории сделок официальный API не отдаёт — только лоты и эту оценку.
В Telethon 1.40 этих методов ещё нет, нужен **1.44+**.

## Tonnel Network — `https://gifts3.tonnel.network`

Мини-апп живёт на `marketplace.tonnel.network` (адрес получен через Telegram,
`requestMainWebView` для [@tonnel_network_bot](https://t.me/tonnel_network_bot)).
Хосты API: `gifts3` (основной), `gifts2` (запасной), `rs-gifts` для RU-региона.

### История сделок

```http
POST /api/saleHistory
{"authData": "<initData>", "page": 1, "limit": 50, "type": "",
 "filter": {"gift_name": "Heroic Helmet",
            "model":   {"$regex": "^Bengal Tiger"},
            "backdrop":{"$regex": "^Black \("},
            "symbol":  {"$regex": "^Owl"},
            "gift_num": 1349},
 "sort": {"timestamp": -1, "gift_id": -1}}
```

Ответ — массив: `{gift_id, gift_num, gift_name, price, asset, timestamp, type,
model, backdrop, symbol, bidder}`.

* `filter` и `sort` здесь **объекты**, а у `/api/pageGifts` — строки с JSON. Легко перепутать.
* `type: ""` = все события. В ответе тип приходит как `INTERNAL_SALE` (сделка) или `BID`
  (ставка на аукционе) — ставки за продажи считать нельзя.
* Атрибуты хранятся вместе с редкостью: `"Bengal Tiger (2.5%)"`, поэтому фильтр — regex по началу.
* `limit` больше 50 отдаёт не список, а объект — постранично по 50.
* `authData` — initData мини-аппа Tonnel.

### Активные лоты

```http
POST /api/pageGifts
{"page":1,"limit":30,"sort":"{\"price\":1,\"gift_id\":-1}",
 "filter":"{\"buyer\":{\"$exists\":false},\"price\":{\"$exists\":true},\"gift_name\":\"Heroic Helmet\"}",
 "ref":"","user_auth":"<initData>"}
```

В ответе коллекция лежит в `name`, а не в `gift_name`; цена — `price`, валюта — `asset`.

Ранее площадка отдавала `403 «Sorry, you have been blocked»` — блокировка Cloudflare
оказалась временной, сейчас всё работает и с обычным `requests`.

## Курс TON/USD и Telegram Stars

| Источник | Что даёт | Ограничение |
|----------|----------|-------------|
| `api.binance.com/api/v3/klines?symbol=TONUSDT&interval=1d` | длинная история дневных свечей | данные заканчиваются 2026-06-30 |
| `api.coingecko.com/api/v3/coins/the-open-network/market_chart?days=365&interval=daily` | свежие 365 дней | у бесплатного ключа `days>365` возвращает пусто |
| `.../market_chart/range?from&to` | точечная догрузка дня | — |
| `api.coingecko.com/api/v3/simple/price?ids=the-open-network` | текущая цена | — |

Итог: Binance даёт «хвост» до 2024-09, CoinGecko — свежие данные, вместе ровно 730 дней
(мин $1.22, макс $6.90). Всё складывается в `ton_usd.json` как `{"YYYY-MM-DD": цена}`;
если события нет в списке — день догружается точечно, а при пробеле берётся ближайший.

Звёзды считаются от долларов по зафиксированным ставкам: покупка 1 ★ = $0.0150,
продажа 1 ★ = $0.0118.

## Getgems — почему не подключён

* `api.getgems.io/graphql` отвечает `GRAPHQL_STRANGE_QUERY` на любые запросы
  («используйте официальный API»), публичный API — по ключу.
* TonAPI работает без ключа, но у подарков нет on-chain истории продаж: у 6 проверенных
  Heroic Helmet в `/v2/nfts/{addr}/history` только `NftItemTransfer`, ни одного
  `NftPurchase`. Торговля идёт вне блокчейна, внутри маркетов.
* Полезное из TonAPI всё же есть: `/v2/nfts/{addr}` резолвит подарок в коллекцию
  (`nft.fragment.com/collection/<slug>.json`), а в items коллекции видно активные
  ордера `sale.market.name = "Getgems Sales"` — но обход всей коллекции упирается
  в лимит страницы (`limit=1000` → 401) и занимает десятки запросов.

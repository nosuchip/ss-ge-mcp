/**
 * Клиент home.ss.ge.
 *
 * Публичного API у ss.ge нет; контракт восстановлен реверс-инжинирингом и проверен
 * живыми запросами — см. docs/API.md. Зависимостей нет: нативный fetch (Node 20+).
 */

export const GATEWAY = "https://api-gateway.ss.ge";
export const TOKEN_PAGE = "https://home.ss.ge/ru";

export const VERSION = "1.0.0";
/** Честный User-Agent: сервер не выдаёт себя за браузер. Проверено — ss.ge отдаёт
 *  и токен, и данные без подделки UA, так что маскироваться незачем. */
export const USER_AGENT = `ss-ge-mcp/${VERSION} (+https://github.com/nosuchip/ss-ge-mcp)`;

export const MAX_PAGE_SIZE = 30;      // 31+ отдаёт 401
export const MAX_IDS_PER_BATCH = 250; // URL длиннее ~4800 символов -> 500

export const DEAL_TYPES = { rent: 1, lease: 2, daily: 3, sale: 4 };
export const ESTATE_TYPES = { cottage: 1, hotel: 2, land: 3, house: 4, flat: 5, commercial: 6 };
export const CURRENCY = { GEL: 1, USD: 2 };
export const PRICE_TYPE = { total: 1, per_m2: 2 };
export const ORDER = {
  date_desc: 1, date_asc: 2,
  price_desc: 3, price_asc: 4,
  unit_price_desc: 5, unit_price_asc: 6,
};

/** Имена, которые API реально понимает. Всё прочее он молча игнорирует,
 *  поэтому опечатка в имени = тихо неотфильтрованная выдача. */
export const FILTER_FIELDS = new Set([
  "realEstateType", "realEstateDealType", "cityIdList", "municipalityId",
  "subdistrictIds", "streetIds", "rooms", "bedroomsCount", "areaFrom", "areaTo",
  "currencyId", "priceType", "priceFrom", "priceTo", "subwayStation",
  "subwayStationDistance", "searchString", "order", "advancedSearch",
  "offerType", "realEstateStatuses", "commercialTypes", "showDeleted", "page", "pageSize",
]);

export const ADVANCED_BOOL_FIELDS = new Set([
  "airConditioning", "balcony", "basement", "cableTelevision", "drinkingWater",
  "electricity", "elevator", "fridge", "furniture", "garage", "glazedWindows",
  "hasRemoteViewing", "heating", "hotWater", "individualEntityOnly", "internet",
  "ironDoor", "isConstruction", "isExclusive", "isPetFriendly", "lastFloor",
  "naturalGas", "securityAlarm", "sewage", "storage", "telephone", "tv",
  "washingMachine", "water", "wiFi", "withBuiltInKitchen", "withImageOnly", "withPool",
]);
export const ADVANCED_LIST_FIELDS = new Set([
  "realEstateStates", "projectTypes", "floorTypes", "toilets", "landType",
]);

export class SsGeError extends Error {}

/** Открывается на 403/429 и держится открытым: если ss.ge нас притормозил,
 *  правильная реакция — перестать долбиться, а не ретраить. */
export class CircuitOpenError extends SsGeError {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Client {
  /**
   * @param {object} [opts]
   * @param {string} [opts.locale]       ru | en | ka — переводит данные, не только UI
   * @param {number} [opts.minInterval]  мс между запросами; глобальный темп
   */
  constructor({ locale = "ru", minInterval = 1000 } = {}) {
    this.locale = locale;
    this.minInterval = minInterval;
    this._token = null;
    this._tokenAt = 0;
    this._queue = Promise.resolve(); // сериализует запросы, чтобы темп был глобальным
    this._lastCall = 0;
    this._chain = null;
    this._chainAt = 0;
    this._circuitOpen = null;
  }

  /** Анонимный app-level JWT, TTL 1 час.
   *  Берём оттуда же, откуда его берёт браузер: сайт кладёт готовый токен
   *  в __NEXT_DATA__ каждой страницы. Так не нужно хранить чужой client_secret. */
  async token() {
    if (this._token && Date.now() - this._tokenAt < 55 * 60 * 1000) return this._token;
    const res = await fetch(TOKEN_PAGE, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new SsGeError(`не удалось загрузить ${TOKEN_PAGE}: HTTP ${res.status}`);
    const html = await res.text();
    const m = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
    );
    if (!m) throw new SsGeError("не найден __NEXT_DATA__ — вёрстка home.ss.ge изменилась");
    const tok = JSON.parse(m[1])?.props?.pageProps?.credentialsToken;
    if (!tok) throw new SsGeError("в __NEXT_DATA__ нет credentialsToken");
    this._token = tok;
    this._tokenAt = Date.now();
    return tok;
  }

  /** Все запросы идут через одну очередь — темп соблюдается глобально, а не на вызов. */
  _paced(fn) {
    const run = this._queue.then(async () => {
      const gap = this.minInterval - (Date.now() - this._lastCall);
      if (gap > 0) await sleep(gap);
      try {
        return await fn();
      } finally {
        this._lastCall = Date.now();
      }
    });
    this._queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async _call(path, { method = "GET", body = null, retry = true } = {}) {
    if (this._circuitOpen)
      throw new CircuitOpenError(
        `ss.ge ответил ${this._circuitOpen.status} и предохранитель разомкнут. ` +
          `Это не сетевой сбой — нас притормозили. Не повторяй запрос, ` +
          `скажи пользователю попробовать существенно позже.`,
      );

    const res = await this._paced(async () => {
      const headers = {
        Authorization: `Bearer ${await this.token()}`,
        "accept-language": this.locale,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      };
      if (body !== null) headers["Content-Type"] = "application/json";
      return fetch(GATEWAY + path, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    });

    if (!res.ok) {
      if (res.status === 403 || res.status === 429) {
        this._circuitOpen = { status: res.status, at: Date.now() };
        throw new CircuitOpenError(
          `ss.ge ответил ${res.status}. Предохранитель разомкнут и останется таким: ` +
            `повторять запросы нельзя, попробовать стоит сильно позже.`,
        );
      }
      // 401 приходит и на протухший токен, и на pageSize > 30 — ss.ge их не различает
      if (res.status === 401 && retry) {
        this._token = null;
        return this._call(path, { method, body, retry: false });
      }
      const text = (await res.text()).slice(0, 400);
      throw new SsGeError(`${method} ${path} -> HTTP ${res.status}: ${text}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /**
   * Собирает и проверяет тело фильтра. Ловит две ошибки, которые сам API не ловит:
   * неизвестное имя поля (молча игнорируется -> неотфильтрованная выдача)
   * и цену без priceType (тоже молча игнорируется).
   */
  static buildFilter(input) {
    const f = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== null) f[k] = v;

    const unknown = Object.keys(f).filter((k) => !FILTER_FIELDS.has(k));
    if (unknown.length)
      throw new SsGeError(
        `API молча проигнорирует эти поля и вернёт неотфильтрованный результат: ` +
          `${unknown.join(", ")}. Заметь: districtIds не существует — ` +
          `район разворачивается в subdistrictIds через LocationChain.`,
      );
    for (const name of ["cityIdList", "subdistrictIds", "streetIds", "rooms", "bedroomsCount"])
      if (name in f && !Array.isArray(f[name]))
        throw new SsGeError(`${name} должен быть массивом чисел`);

    if (("priceFrom" in f || "priceTo" in f) && !("priceType" in f)) f.priceType = PRICE_TYPE.total;
    if ("priceType" in f && !("currencyId" in f)) f.currencyId = CURRENCY.USD;

    if ("advancedSearch" in f) {
      const adv = f.advancedSearch;
      if (typeof adv !== "object" || Array.isArray(adv))
        throw new SsGeError("advancedSearch должен быть объектом, а не JSON-строкой");
      const bad = Object.keys(adv).filter(
        (k) => !ADVANCED_BOOL_FIELDS.has(k) && !ADVANCED_LIST_FIELDS.has(k),
      );
      if (bad.length)
        throw new SsGeError(
          `неизвестные ключи advancedSearch (будут проигнорированы): ${bad.join(", ")}`,
        );
    }
    return f;
  }

  /** Два счётчика ss.ge; они не совпадают и означают разное. */
  async count(filter) {
    const d = await this._call("/v3/RealEstate/legend-search-count", {
      method: "POST",
      body: { ...filter, pageSize: 1 },
    });
    return { cards: d.cardCount, applications: d.applicationCount };
  }

  /** Страница выдачи. Единственный источник настоящей createDate. */
  async searchPage(filter, page = 1, pageSize = MAX_PAGE_SIZE) {
    if (pageSize > MAX_PAGE_SIZE) throw new SsGeError(`pageSize > ${MAX_PAGE_SIZE} отдаёт 401`);
    const d = await this._call("/v1/RealEstate/LegendSearch", {
      method: "POST",
      body: { ...filter, page, pageSize },
    });
    return d?.realStateItemModel ?? []; // totalCount в ответе всегда 0 — не использовать
  }

  /** Постранично, с датами публикации. ~1 запрос на 30 объектов. */
  async search(filter, limit = 30) {
    const out = [];
    for (let page = 1; out.length < limit; page++) {
      const items = await this.searchPage(filter, page);
      if (!items.length) break;
      for (const it of items) {
        out.push(it);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /** Весь результат одним ответом: id + цена + координаты, без пагинации.
   *  Без фильтров это ~144k объектов и 35 МБ, отсюда guard. */
  async mapSearch(filter, { guard = true } = {}) {
    if (guard && !filter.cityIdList?.length && !filter.realEstateDealType)
      throw new SsGeError(
        "слишком широкий запрос: MapSearch без фильтра отдаёт ~144000 объектов (35 МБ). " +
          "Задай город или тип сделки.",
      );
    const d = await this._call("/v1/RealEstate/MapSearch", { method: "POST", body: filter });
    return d?.realStateMapItemModel ?? [];
  }

  /** Полные карточки батчами.
   *  ВНИМАНИЕ: createDate здесь приходит как 0001-01-01 (не заполнено), а orderDate —
   *  дата платного поднятия, не публикации. Нужна свежесть — только search(). */
  async cardsByIds(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += MAX_IDS_PER_BATCH) {
      const chunk = ids.slice(i, i + MAX_IDS_PER_BATCH).join(",");
      const d = await this._call(`/v1/RealEstate/MapSearchByIds?applicationIds=${chunk}`);
      out.push(...(d?.mapSearchByIdItemModel ?? [])); // порядок не сохраняется
    }
    return out;
  }

  /** Полная карточка: удобства, координаты, кадастр, viewCount. Метод — PUT. */
  async listing(applicationId, currencyId = CURRENCY.USD) {
    return this._call(
      `/v1/RealEstate/details?applicationId=${applicationId}` +
        `&currencyId=${currencyId}&updateViewCount=false`,
      { method: "PUT" },
    );
  }

  /** Город -> район -> микрорайон -> улица, с координатами. ~660 КБ, кешируем на процесс. */
  async locationChain() {
    if (this._chain && Date.now() - this._chainAt < 6 * 60 * 60 * 1000) return this._chain;
    this._chain = await this._call("/v1/RealEstate/LocationChain");
    this._chainAt = Date.now();
    return this._chain;
  }

  async currencyRate() {
    return this._call("/v1/RealEstate/currency-rate");
  }

  static urlOf(card) {
    return "https://home.ss.ge/ru/недвижимость/" + card.detailUrl;
  }
}

#!/usr/bin/env node
/**
 * ss-ge-mcp — MCP-сервер над home.ss.ge.
 *
 * Прозрачный stateless-прокси: один вызов инструмента = один-несколько живых запросов
 * к api-gateway.ss.ge. Между вызовами не хранится ничего, кроме кеша токена (TTL 1 ч)
 * и гео-справочника. Публичного API у ss.ge нет — контракт восстановлен реверс-
 * инжинирингом, разбор и грабли в docs/API.md.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  ADVANCED_BOOL_FIELDS, CURRENCY, Client, DEAL_TYPES, ESTATE_TYPES,
  ORDER, PRICE_TYPE, VERSION,
} from "./client.mjs";
import { resolveCity, resolveSubdistricts } from "./geo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS = ["apartment-search", "criteria-coverage"];

const INSTRUCTIONS = `\
ss-ge-mcp — прозрачный прокси над home.ss.ge (крупнейшая доска недвижимости Грузии,
публичного API нет). Один вызов = живая выборка; между вызовами ничего не кешируется.

Прежде чем собирать многокритериальный поиск, вызови get_skill('apartment-search') —
он раскладывает критерии пользователя по инструментам и задаёт порядок от грубого
к точному. get_skill('criteria-coverage') говорит, на что ss.ge отвечает, а на что нет.

ВСЕГДА сообщай свежесть. search(mode="paged") возвращает published — настоящую дату
публикации. search(mode="fast") её НЕ возвращает (published=null): API в этом режиме
отдаёт незаполненную дату. null означает НЕИЗВЕСТНО, а не «свежее» — никогда не выдавай
объявление из fast-режима за актуальное. Поле bumped есть в обоих режимах, но это дата
платного поднятия, а не публикации: у топовых объявлений она почти всегда «сегодня»,
и признаком свежести служить не может.

Счётчиков три, и они не совпадают: cards (карточки после схлопывания дублей — именно
столько отдаёт постраничная выборка), applications (сырые объявления с дублями),
mapped (объекты с координатами). Ни один не равен «числу уникальных квартир»: одно
жильё часто висит несколькими объявлениями. Сообщай их раздельно и не выдавай одно
из них за «итоговое» число.

Фильтр по району работает ТОЛЬКО через микрорайоны: поля districtIds в API нет.
Передавай названия в subdistricts — район раскрывается во все свои микрорайоны сам;
либо возьми id через geo(). Таксономия ss.ge отдаётся как есть, не нормализуется.
Цены приходят сразу в USD и GEL, конвертировать не нужно.

Выдача всегда частичная: search отдаёт максимум limit объектов, а не весь набор.
Всегда сопоставляй returned со счётчиком cards из того же ответа.

Запросы идут в темпе 1 rps с честным User-Agent. Если ss.ge ответит 403 или 429,
предохранитель размыкается и остаётся разомкнутым — это сделано намеренно: не повторяй
запрос, скажи пользователю попробовать существенно позже.`;

const client = new Client({
  locale: process.env.SSGE_LOCALE ?? "ru",
  minInterval: Number(process.env.SSGE_MIN_INTERVAL_MS ?? 1000),
});

/* ------------------------------------------------------------------ форматирование */

/** Единая форма карточки. published=false -> дата публикации недоступна (не «свежее»). */
function card(it, { published }) {
  const a = it.address ?? {};
  const p = it.price ?? {};
  let created = it.createDate ?? null;
  if (created?.startsWith("0001")) created = null; // API отдаёт незаполненную дату

  return {
    id: it.applicationId,
    title: it.title,
    price_usd: p.priceUsd ?? null,
    price_gel: p.priceGeo ?? null,
    per_m2_usd: p.unitPriceUsd ?? null,
    area_m2: it.totalArea ?? null,
    bedrooms: it.numberOfBedrooms ?? null,
    floor: it.floorNumber ?? null,
    floors_total: it.totalAmountOfFloor ?? null,
    city: a.cityTitle ?? null,
    district: a.districtTitle ?? null,
    subdistrict: a.subdistrictTitle ?? null,
    street: a.streetTitle ?? null,
    street_number: a.streetNumber ?? null,
    lat: it.locationLatitude ?? null,
    lon: it.locationLongitude ?? null,
    published: published ? created : null, // null = НЕИЗВЕСТНО
    bumped: it.orderDate ? it.orderDate.slice(0, 10) : null, // платное поднятие
    furniture: it.furniture ?? null,
    images: it.imageCount ?? it.imagesCount ?? null,
    url: it.detailUrl ? Client.urlOf(it) : null,
  };
}

const COUNTS_NOTE =
  "cards — карточки после схлопывания дублей (столько отдаёт пагинация); " +
  "applications — сырые объявления с дублями; mapped — объекты с координатами. " +
  "Три числа означают разное; ни одно не равно числу уникальных квартир.";

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });
const fail = (e) => ({
  content: [{ type: "text", text: `Ошибка: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

async function buildFilter(a) {
  const { id: cityId, title: cityTitle } = await resolveCity(client, a.city ?? "Тбилиси");
  let sdIds = [];
  let sdLabels = [];
  if (a.subdistricts?.length)
    ({ ids: sdIds, labels: sdLabels } = await resolveSubdistricts(client, cityId, a.subdistricts));

  const input = {
    realEstateDealType: DEAL_TYPES[a.deal],
    realEstateType: ESTATE_TYPES[a.estate ?? "flat"],
    cityIdList: [cityId],
    subdistrictIds: sdIds.length ? sdIds : undefined,
    rooms: a.rooms?.length ? a.rooms : undefined,
    areaFrom: a.area_min,
    areaTo: a.area_max,
    order: a.order ? ORDER[a.order] : undefined,
    advancedSearch: a.features?.length
      ? Object.fromEntries(a.features.map((k) => [k, true]))
      : undefined,
  };
  if (a.price_min != null || a.price_max != null) {
    // priceType обязателен: без него API молча игнорирует ценовой фильтр целиком
    input.priceType = a.price_per_m2 ? PRICE_TYPE.per_m2 : PRICE_TYPE.total;
    input.currencyId = CURRENCY[a.currency ?? "USD"];
    input.priceFrom = a.price_min ?? undefined;
    input.priceTo = a.price_max ?? undefined;
  }

  return {
    filter: Client.buildFilter(input),
    echo: {
      city: cityTitle,
      subdistricts: sdLabels.length ? sdLabels : "весь город",
      deal: a.deal,
      estate: a.estate ?? "flat",
    },
  };
}

/* ------------------------------------------------------------------------- схема */

const filterShape = {
  deal: z.enum(["rent", "sale", "lease", "daily"]).describe("тип сделки"),
  city: z.string().default("Тбилиси").describe("название или id города, напр. «Тбилиси» или 95"),
  estate: z
    .enum(["flat", "house", "land", "commercial", "hotel", "cottage"])
    .default("flat")
    .describe("тип недвижимости"),
  subdistricts: z
    .array(z.string())
    .optional()
    .describe(
      "микрорайоны или районы по названию/id. Название района раскрывается во все его " +
        "микрорайоны — отдельного фильтра по району в API нет",
    ),
  rooms: z.array(z.number().int()).optional().describe("число комнат, напр. [2,3]"),
  price_min: z.number().optional().describe("нижняя граница цены"),
  price_max: z.number().optional().describe("верхняя граница цены"),
  currency: z.enum(["USD", "GEL"]).default("USD").describe("валюта цены в фильтре"),
  price_per_m2: z.boolean().default(false).describe("цена задана за м², а не целиком"),
  area_min: z.number().optional().describe("площадь от, м²"),
  area_max: z.number().optional().describe("площадь до, м²"),
  features: z
    .array(z.enum([...ADVANCED_BOOL_FIELDS]))
    .optional()
    .describe("булевы удобства: elevator, furniture, heating, balcony, garage, withImageOnly и др."),
};

/* ---------------------------------------------------------------------- сервер */

const server = new McpServer({ name: "ss-ge", version: VERSION }, { instructions: INSTRUCTIONS });

server.registerTool(
  "get_skill",
  {
    title: "Инструкция по работе с источником",
    description:
      "Возвращает инструкцию. 'apartment-search' — как разложить критерии пользователя " +
      "по инструментам и в каком порядке идти. 'criteria-coverage' — на что ss.ge " +
      "отвечает, на что отвечает приблизительно, и чего не знает вовсе. " +
      "Вызывай перед сборкой многокритериального поиска.",
    inputSchema: { name: z.enum(SKILLS).describe("имя инструкции") },
  },
  async ({ name }) => {
    try {
      return { content: [{ type: "text", text: await readFile(join(HERE, "skills", `${name}.md`), "utf8") }] };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "search",
  {
    title: "Поиск объявлений",
    description:
      "Ищет объявления на home.ss.ge. Возвращает частичную выдачу — сравнивай returned " +
      "со счётчиком cards. mode='paged' даёт published (реальную дату публикации), " +
      "mode='fast' — нет (published=null, это НЕИЗВЕСТНО, а не «свежее»). " +
      "Цены отдаются сразу в USD и GEL.",
    inputSchema: {
      ...filterShape,
      order: z
        .enum(["date_desc", "date_asc", "price_desc", "price_asc", "unit_price_desc", "unit_price_asc"])
        .optional()
        .describe("сортировка; по умолчанию — релевантность/VIP самого сайта"),
      mode: z
        .enum(["paged", "fast"])
        .default("paged")
        .describe(
          "paged — с датами публикации, ~30 объектов на запрос. " +
            "fast — в разы быстрее (весь набор одним запросом), но БЕЗ дат публикации",
        ),
      limit: z.number().int().min(1).max(200).default(30).describe("сколько объектов вернуть"),
    },
  },
  async (a) => {
    try {
      const { filter, echo } = await buildFilter(a);
      const counts = await client.count(filter);
      let listings;
      let mapped = null;
      let freshness;

      if (a.mode === "fast") {
        const pts = await client.mapSearch(filter);
        mapped = pts.length;
        const ids = pts.slice(0, a.limit).map((p) => p.applicationId);
        listings = (await client.cardsByIds(ids)).map((x) => card(x, { published: false }));
        freshness =
          "published недоступна в этом режиме — API отдаёт незаполненную дату. " +
          "null = НЕИЗВЕСТНО, не «свежее». Нужны даты — вызови с mode='paged'.";
      } else {
        listings = (await client.search(filter, a.limit)).map((x) => card(x, { published: true }));
        freshness = "published — реальная дата публикации объявления.";
      }

      return ok({
        query: echo,
        counts: { ...counts, mapped, note: COUNTS_NOTE },
        returned: listings.length,
        freshness,
        listings,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "count",
  {
    title: "Счётчики по фильтру",
    description:
      "Считает результаты по фильтру, не выкачивая их — один дешёвый запрос. " +
      "Годится, чтобы проверить осмысленность критериев и сравнить варианты фильтра. " +
      "Возвращает два несовпадающих счётчика; сообщай их раздельно.",
    inputSchema: filterShape,
  },
  async (a) => {
    try {
      const { filter, echo } = await buildFilter(a);
      const c = await client.count(filter);
      return ok({ query: echo, ...c, note: COUNTS_NOTE });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "listing",
  {
    title: "Карточка объявления",
    description:
      "Полная карточка: удобства, координаты, этажность, состояние ремонта, кадастровый " +
      "код, просмотры, контакт. Настоящей даты публикации здесь нет — API её в этом " +
      "ответе не отдаёт; bumped и expires относятся к платному размещению.",
    inputSchema: {
      application_id: z.number().int().describe("id объявления (поле id из search)"),
      currency: z.enum(["USD", "GEL"]).default("USD").describe("валюта, в которой считать цену"),
    },
  },
  async ({ application_id, currency }) => {
    try {
      const d = await client.listing(application_id, CURRENCY[currency]);
      const a = d.address ?? {};
      const p = d.price ?? {};
      return ok({
        id: d.applicationId,
        title: d.title,
        description: d.description,
        price_usd: p.priceUsd ?? null,
        price_gel: p.priceGeo ?? null,
        per_m2_usd: p.unitPriceUsd ?? null,
        area_m2: d.totalArea ?? null,
        rooms: d.rooms ?? null,
        bedrooms: d.bedrooms ?? null,
        floor: d.floor ?? null,
        floors_total: d.floors ?? null,
        state: d.realEstateStatus ?? null,
        project: d.project ?? null,
        address: {
          city: a.cityTitle ?? null,
          district: a.districtTitle ?? null,
          subdistrict: a.subdistrictTitle ?? null,
          street: a.streetTitle ?? null,
          street_number: a.streetNumber ?? null,
        },
        lat: d.locationLatitude ?? null,
        lon: d.locationLongitude ?? null,
        cadastral_code: d.cadastralCode ?? null,
        amenities: [...ADVANCED_BOOL_FIELDS].filter((k) => d[k] === true).sort(),
        view_count: d.viewCount ?? null,
        agency: d.agencyName ?? d.companyName ?? null,
        contact: d.contactPerson ?? null,
        nearby_metro: d.nearbySubwayStations ?? null,
        bumped: d.orderDate ? d.orderDate.slice(0, 10) : null,
        expires: d.endDate ? d.endDate.slice(0, 10) : null,
        published: null,
        freshness_note:
          "published недоступна в этом ответе — null означает НЕИЗВЕСТНО. " +
          "Реальная дата публикации есть только в search(mode='paged').",
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "geo",
  {
    title: "Справочник локаций",
    description:
      "Районы города и их микрорайоны с id. Нужен потому, что фильтровать по району " +
      "через API нельзя — только перечислением микрорайонов. search() принимает названия " +
      "и резолвит их сам; этот инструмент — посмотреть доступное или снять неоднозначность.",
    inputSchema: { city: z.string().default("Тбилиси").describe("название или id города") },
  },
  async ({ city }) => {
    try {
      const { id, title } = await resolveCity(client, city);
      const chain = await client.locationChain();
      const c = chain.visibleCities.find((x) => x.cityId === id);
      return ok({
        city: title,
        city_id: id,
        districts: c.districts.map((d) => ({
          district_id: d.districtId,
          district: d.districtTitle,
          subdistricts: d.subDistricts.map((sd) => ({
            id: sd.subDistrictId,
            title: sd.subDistrictTitle,
          })),
        })),
        note: "Для фильтра используются subdistricts. districtIds в API не существует. " +
              "Таксономия ss.ge отдана как есть.",
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "cities",
  {
    title: "Города",
    description: "Города, по которым ss.ge ведёт выдачу, и текущий курс USD/GEL.",
    inputSchema: {},
  },
  async () => {
    try {
      const chain = await client.locationChain();
      return ok({
        cities: chain.visibleCities.map((c) => ({
          id: c.cityId,
          title: c.cityTitle,
          districts: c.districts.length,
        })),
        rate: await client.currencyRate(),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());

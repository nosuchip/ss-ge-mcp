/**
 * Резолв локаций.
 *
 * Существует потому, что фильтровать по району через API нельзя: поля districtIds
 * в DTO нет (сайт кладёт его в свой URL, сервер игнорирует). Единственный способ —
 * перечислить микрорайоны, поэтому название района раскрывается во все его микрорайоны.
 */
import { SsGeError } from "./client.mjs";

export async function resolveCity(client, city) {
  const { visibleCities } = await client.locationChain();
  if (typeof city === "number" || /^\d+$/.test(String(city))) {
    const id = Number(city);
    const hit = visibleCities.find((c) => c.cityId === id);
    if (!hit) throw new SsGeError(`город с id ${id} не найден`);
    return { id, title: hit.cityTitle };
  }
  const needle = String(city).trim().toLowerCase();
  const hit =
    visibleCities.find((c) => c.cityTitle.toLowerCase() === needle) ??
    visibleCities.find((c) => c.cityTitle.toLowerCase().includes(needle));
  if (!hit)
    throw new SsGeError(
      `город "${city}" не найден. Доступны: ${visibleCities.map((c) => c.cityTitle).join(", ")}`,
    );
  return { id: hit.cityId, title: hit.cityTitle };
}

/** Названия/id микрорайонов -> id. Название района раскрывается во все его микрорайоны. */
export async function resolveSubdistricts(client, cityId, names) {
  const chain = await client.locationChain();
  const city = chain.visibleCities.find((c) => c.cityId === cityId);
  if (!city) throw new SsGeError(`город с id ${cityId} не найден`);

  const flat = [];
  const districts = new Map();
  for (const d of city.districts) {
    districts.set(d.districtTitle.toLowerCase(), d);
    for (const sd of d.subDistricts) flat.push([sd.subDistrictId, sd.subDistrictTitle]);
  }

  const ids = [];
  const labels = [];
  for (const raw of names) {
    if (typeof raw === "number" || /^\d+$/.test(String(raw))) {
      const sid = Number(raw);
      const hit = flat.find(([i]) => i === sid);
      if (!hit) throw new SsGeError(`микрорайон с id ${sid} не найден в городе ${cityId}`);
      ids.push(sid);
      labels.push(hit[1]);
      continue;
    }
    const needle = String(raw).trim().toLowerCase();
    if (districts.has(needle)) {
      for (const sd of districts.get(needle).subDistricts) {
        ids.push(sd.subDistrictId);
        labels.push(sd.subDistrictTitle);
      }
      continue;
    }
    const exact = flat.filter(([, t]) => t.toLowerCase() === needle);
    const part = exact.length ? exact : flat.filter(([, t]) => t.toLowerCase().includes(needle));
    if (!part.length)
      throw new SsGeError(
        `микрорайон "${raw}" не найден в городе ${city.cityTitle}. ` +
          `Посмотри доступные через geo(city="${city.cityTitle}").`,
      );
    for (const [i, t] of part) {
      ids.push(i);
      labels.push(t);
    }
  }
  return { ids: [...new Set(ids)], labels: [...new Set(labels)] };
}

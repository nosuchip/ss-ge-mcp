/**
 * Smoke-тест: поднимает сервер и дёргает инструменты по-настоящему, вживую.
 * Ходит в сеть — офлайн упадёт, и это ожидаемо.
 *
 *   npm test
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.mjs");
const proc = spawn("node", [ENTRY], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const queue = [];
let waiter = null;
proc.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line.startsWith("{")) continue;
    const msg = JSON.parse(line);
    if (waiter) { waiter(msg); waiter = null; } else queue.push(msg);
  }
});
const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => (waiter = r)));
const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");

let id = 0;
const call = async (name, args) => {
  send({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
  const r = await next();
  return { text: r.result.content[0].text, isError: !!r.result.isError };
};

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
};

send({ jsonrpc: "2.0", id: ++id, method: "initialize", params: {
  protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
const init = await next();
check("initialize", init.result.serverInfo.name === "ss-ge", init.result.serverInfo.version);
check("instructions отданы", (init.result.instructions ?? "").length > 500);
send({ jsonrpc: "2.0", method: "notifications/initialized" });

send({ jsonrpc: "2.0", id: ++id, method: "tools/list" });
const tools = (await next()).result.tools.map((t) => t.name).sort();
check("набор инструментов", tools.join(",") === "cities,count,geo,get_skill,listing,search", tools.join(","));

const skill = await call("get_skill", { name: "apartment-search" });
check("get_skill отдаёт инструкцию", skill.text.includes("от грубого к точному"));

const geo = await call("geo", { city: "Тбилиси" });
check("geo: 5 районов Тбилиси", JSON.parse(geo.text).districts.length === 5);

const cnt = JSON.parse((await call("count", { deal: "sale", subdistricts: ["Ваке"] })).text);
check("count отдаёт два счётчика", cnt.cards > 0 && cnt.applications > cnt.cards,
  `cards=${cnt.cards} applications=${cnt.applications}`);

// район раскрывается во все микрорайоны — фильтра по району в API нет
const dist = JSON.parse((await call("count", { deal: "rent", subdistricts: ["Ваке-Сабуртало"] })).text);
check("район раскрыт в микрорайоны", dist.query.subdistricts.length === 13,
  `${dist.query.subdistricts.length} шт.`);

// priceType подставляется автоматически, иначе цена молча игнорируется
const wide = JSON.parse((await call("count", { deal: "sale", subdistricts: ["Ваке"] })).text);
const narrow = JSON.parse((await call("count",
  { deal: "sale", subdistricts: ["Ваке"], price_min: 80000, price_max: 140000 })).text);
check("ценовой фильтр реально применяется", narrow.cards < wide.cards,
  `${wide.cards} -> ${narrow.cards}`);

const paged = JSON.parse((await call("search",
  { deal: "sale", subdistricts: ["Ваке"], limit: 3, order: "date_desc" })).text);
check("search paged отдаёт объекты", paged.listings.length === 3);
check("paged: есть дата публикации", paged.listings.every((l) => l.published));
check("paged: цены в двух валютах", paged.listings.every((l) => l.price_usd && l.price_gel));

const fast = JSON.parse((await call("search",
  { deal: "sale", subdistricts: ["Ваке"], limit: 3, mode: "fast" })).text);
check("fast: published честно null", fast.listings.every((l) => l.published === null));
check("fast: есть mapped", typeof fast.counts.mapped === "number", String(fast.counts.mapped));

const one = JSON.parse((await call("listing", { application_id: paged.listings[0].id })).text);
check("listing: координаты", one.lat && one.lon);
check("listing: удобства списком", Array.isArray(one.amenities));

// неизвестное удобство должно отвергаться схемой, а не уходить в API молча
const bad = await call("search", { deal: "sale", features: ["nonsense"], limit: 1 });
check("неизвестный feature отвергнут", bad.isError);

proc.kill();
console.log(failures ? `\n${failures} проверок упало` : "\nвсе проверки прошли");
process.exit(failures ? 1 : 0);

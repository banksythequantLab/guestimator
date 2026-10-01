// Run:  node worker/tests/pricecheck_test.mjs
// Price check through the REAL route, SoldComps stubbed at fetch(). Proves which listings are
// checked, where the evidence comes from (a fresh estimate vs a lookup), the verdicts and the
// suggested price - NOT that SoldComps' matches are the same item; that needs eyes on real results.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as P from "../pricecheck.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

// ---------- pure ----------
ok("no sales -> none", P.verdict(10000, null).verdict === "none");
ok("two sales -> too thin to judge", P.verdict(10000, { count: 2, median: 50 }).verdict === "thin");
const hi = P.verdict(19900, { count: 5, median: 152.5 });
ok("well above median -> high, suggest the median rounded down", hi.verdict === "high" && hi.suggested_cents === 15200 && hi.pct === 30, hi);
ok("within 15% -> in line", P.verdict(11000, { count: 4, median: 100 }).verdict === "ok");
const lo = P.verdict(7000, { count: 4, median: 100 });
ok("well below -> low, no price change offered", lo.verdict === "low" && lo.pct === 30 && !lo.suggested_cents, lo);
ok("50c steps under $20", P.niceDown(1789) === 1750 && P.niceDown(2099) === 2000);

// ---------- SoldComps, stubbed ----------
const lookups = []; let outage = false;
const jr = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const S = (title, price) => ({ title, url: "https://www.ebay.com/itm/9?nordt=true", soldPrice: String(price), soldCurrency: "USD", shippingPrice: "0", endedAt: "2026-09-20", condition: "Pre-Owned" });
globalThis.fetch = async u => {
  const url = new URL(String(u));
  if (url.hostname === "api.sold-comps.com") {
    const kw = url.searchParams.get("keyword"); lookups.push(kw);
    if (outage) return jr({ error: "upstream" }, 503);
    if (/Tesla/i.test(kw)) return jr({ items: [S("Nvidia Tesla M10 32GB GPU", 60), S("NVIDIA Tesla M10 GPU card", 70), S("Tesla M10 32GB", 80), S("Tesla M10 GPU", 75)] });
    return jr({ items: [] });
  }
  return jr({ errors: [{ message: "unstubbed " + url }] }, 404);
};

const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, ASSETS: { fetch: async () => new Response("a") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", SOLDCOMPS_API_KEY: "sc_test" };
let cookie = "";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const t = await r.text(); let json = null; try { json = JSON.parse(t); } catch {}
  return { status: r.status, json };
};
ok("signed out -> refused", (await call("GET", "/api/ebay/pricecheck")).status === 401);
await call("POST", "/api/auth/register", { email: "d@example.com", password: "password123" });
const me = db.raw.prepare("SELECT id FROM users WHERE email='d@example.com'").get().id;
const ago = d => new Date(Date.now() - d * 86400e3).toISOString();
const mk = async (name, priceCents, result, { status = "published", live = "live" } = {}) => {
  const id = (await call("POST", "/api/items", { name, description: name })).json.id;
  db.raw.prepare("UPDATE items SET listing_status=?, price_cents=? WHERE id=?").run(live, priceCents, id);
  db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)").run(crypto.randomUUID(), id, JSON.stringify(result), ago(1));
  const lid = crypto.randomUUID();
  db.raw.prepare("INSERT INTO ebay_listings (id,item_id,user_id,sku,status,offer_id,listing_id,listing_url,price_cents,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(lid, id, me, "GUESS-" + id.replace(/-/g, ""), status, "OFF-" + name, "L-" + name, "https://www.ebay.com/itm/1", priceCents, ago(5), ago(5));
  return lid;
};
const gpu = await mk("Tesla", 8500, { identification: { name: "Nvidia Tesla M10 GPU", maker: "Nvidia", period: "2015" } });
const ram = await mk("RAM", 19900, { identification: { name: "SK Hynix 32GB DDR4" },
  sold_market: { count: 4, low: 126, high: 200, median: 159, as_of: ago(2), recent: [{ title: "SK Hynix 32GB", url: "https://www.ebay.com/itm/5", price: 159, sold_at: "2026-09-29" }] } });
const odd = await mk("Optane", 18000, { identification: { name: "Intel Optane DCPMM 256GB" } });
await mk("Sold one", 5000, { identification: { name: "Sold lamp" } }, { live: "sold" });
await mk("Draft", 5000, { identification: { name: "Draft lamp" } }, { status: "draft" });

const r = await call("GET", "/api/ebay/pricecheck");
const by = Object.fromEntries((r.json?.listings || []).map(l => [l.id, l]));
ok("only live, published listings are checked", r.status === 200 && r.json.listings.length === 3, r.json);
ok("fresh estimate's sold prices reused, no lookup", by[ram].source === "estimate" && !lookups.some(k => /Hynix/i.test(k)) && by[ram].verdict === "high" && by[ram].suggested_cents === 15900, by[ram]);
ok("otherwise a lookup with the estimate's terms", by[gpu].source === "fresh" && lookups.some(k => /Nvidia Tesla M10/.test(k)), lookups);
ok("GPU at $85 vs median $73 -> above, suggest $73", by[gpu].verdict === "high" && by[gpu].suggested_cents === 7300 && by[gpu].sold.count === 4, by[gpu]);
ok("no sales -> none, with the reason", by[odd].verdict === "none" && !by[odd].sold && typeof by[odd].why === "string" && by[odd].why.length > 0, by[odd]);
ok("sale links cleaned, at most three shown", by[gpu].recent.length === 3 && !by[gpu].recent[0].url.includes("nordt"), by[gpu].recent);
ok("offer ids and SKUs stay server-side", !("offer_id" in by[gpu]) && !("sku" in by[gpu]));

// a failed lookup never overwrites what was found before
const cached = () => db.raw.prepare("SELECT sold_count n, sold_median_cents m FROM ebay_listings WHERE id=?").get(gpu);
ok("first check cached the GPU's sales", cached().n === 4 && cached().m === 7300, cached());
ok("and the Optane's genuine none as 0", db.raw.prepare("SELECT sold_count n, sold_checked_at t FROM ebay_listings WHERE id=?").get(odd).n === 0);
outage = true;
const r2 = await call("GET", "/api/ebay/pricecheck");
ok("during an outage the GPU says why", r2.json.listings.find(l => l.id === gpu).verdict === "none" && /503/.test(r2.json.listings.find(l => l.id === gpu).why), r2.json.listings.find(l => l.id === gpu));
ok("but its cached sales are kept", cached().n === 4 && cached().m === 7300, cached());
outage = false;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
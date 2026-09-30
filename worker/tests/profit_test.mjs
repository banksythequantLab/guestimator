// Run:  node worker/tests/profit_test.mjs
// Profit report through the real routes against the D1 shim: three kinds of sale, fees, a label,
// cost basis, date ranges, CSV, and that nobody sees anyone else's numbers.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as P from "../profit.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

ok("stripe estimate 2.9% + 30c", P.STRIPE_EST(10000) === 320);
ok("csv escapes commas and quotes", P.profitCsv({ rows: [{ at: "2026-09-01T00:00:00Z", channel: "eBay", title: 'Crock, "3 gal"', sale_cents: 1000, ship_paid_cents: 0, fee_cents: 100, fee_note: "x", label_cents: null, cost_cents: 200, profit_cents: 700 }],
  totals: { sales: 1, sale_cents: 1000, ship_paid_cents: 0, fee_cents: 100, label_cents: 0, cost_cents: 200, profit_cents: 700 } }).includes('"Crock, ""3 gal"""'));

globalThis.fetch = async () => new Response("{}", { status: 404 });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, ASSETS: { fetch: async () => new Response("a") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} }, PUBLIC_ORIGIN: "https://g.test" };
let cookie = "";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
};
await call("POST", "/api/auth/register", { email: "d@example.com", password: "password123" });
const me = db.raw.prepare("SELECT id FROM users WHERE email='d@example.com'").get().id;
const mk = async name => (await call("POST", "/api/items", { name, description: name })).json.id;
const crock = await mk("Crock"), ram = await mk("RAM"), lamp = await mk("Lamp"), shelf = await mk("Shelf");
db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)").run(crypto.randomUUID(), shelf, JSON.stringify({ price_range: { suggested_retail: 45 } }), "2026-09-01T00:00:00Z");

// cost basis
ok("save cost", (await call("PUT", `/api/items/${crock}/cost`, { cost: "$12.50" })).json.cost_cents === 1250);
ok("bad cost refused", (await call("PUT", `/api/items/${ram}/cost`, { cost: "abc" })).status === 400);
await call("PUT", `/api/items/${ram}/cost`, { cost: "20" });
await call("PUT", `/api/items/${shelf}/cost`, { cost: "5" });
ok("item bundle carries the cost", (await call("GET", `/api/items/${crock}`)).json.finance.cost_cents === 1250);

// a sale page with: crock sold in person, lamp bought online and shipped with a label
const sid = crypto.randomUUID(), t = "2026-09-20T15:00:00Z";
db.raw.prepare("INSERT INTO garage_sales (id,user_id,slug,title,kind,city,state,starts_on,ends_on,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(sid, me, "s1", "Sale", "garage", "X", "NJ", "2026-09-20", "2026-09-20", "published", t, t);
db.raw.prepare("INSERT INTO garage_sale_items (sale_id,item_id,price_cents,status,sold_at,added_at) VALUES (?,?,?,?,?,?)").run(sid, crock, 4000, "sold", t, t);
db.raw.prepare("INSERT INTO garage_sale_items (sale_id,item_id,price_cents,status,sold_at,added_at) VALUES (?,?,?,?,?,?)").run(sid, lamp, 3000, "sold", t, t);
db.raw.prepare("INSERT INTO garage_orders (id,sale_id,item_id,seller_account,fulfilment,item_cents,ship_cents,fee_cents,total_cents,status,created_at,updated_at) VALUES ('go1',?,?,'acct','ship',3000,800,114,3800,'fulfilled',?,?)").run(sid, lamp, t, t);
db.raw.prepare("INSERT INTO shipping_labels (id,user_id,kind,order_id,transaction_id,amount_cents,created_at) VALUES ('lb1',?,'garage','go1','tx',745,?)").run(me, t);
// RAM sold on eBay in August
db.raw.prepare("INSERT INTO ebay_orders (id,order_id,line_item_id,user_id,item_id,title,total_cents,ship_paid_cents,fee_cents,status,ordered_at,created_at,updated_at) VALUES ('o:1','o','1',?,?,'RAM',6000,0,795,'FULFILLED','2026-08-10T00:00:00Z',?,?)").run(me, ram, t, t);

let r = await call("GET", "/api/profit");
const by = ch => r.json.rows.find(x => x.channel === ch);
ok("three sales, newest first", r.status === 200 && r.json.rows.length === 3 && r.json.rows[2].channel === "eBay", r.json.rows.map(x => x.channel));
ok("in person: tag price minus cost", by("At the sale").sale_cents === 4000 && by("At the sale").profit_cents === 4000 - 1250);
const on = by("Online (sale page)");
ok("online: item + shipping - platform fee - Stripe est - label", on.profit_cents === 3000 + 800 - (114 + P.STRIPE_EST(3800)) - 745 && on.missing_cost, on);
ok("eBay: total - eBay fee - cost", by("eBay").profit_cents === 6000 - 795 - 2000);
ok("totals add up", r.json.totals.profit_cents === r.json.rows.reduce((s, x) => s + x.profit_cents, 0) && r.json.totals.missing_cost === 1);
ok("inventory: unsold priced item and its cost", r.json.inventory.items === 1 && r.json.inventory.estimate_cents === 4500 && r.json.inventory.cost_cents === 500, r.json.inventory);
r = await call("GET", "/api/profit?from=2026-09-01&to=2026-09-30");
ok("date range", r.json.rows.length === 2 && r.json.rows.every(x => x.channel !== "eBay"));
r = await call("GET", "/api/profit/csv?from=&to=");
ok("csv download", r.status === 200 && /text\/csv/.test(r.headers.get("content-type")) && /attachment/.test(r.headers.get("content-disposition")) && r.text.split("\r\n").length === 6 && r.text.includes("TOTAL"));

cookie = ""; await call("POST", "/api/auth/register", { email: "x@example.com", password: "password123" });
r = await call("GET", "/api/profit");
ok("another user sees none of it", r.json.rows.length === 0 && r.json.inventory.items === 0);
ok("and can't set someone else's cost", (await call("PUT", `/api/items/${crock}/cost`, { cost: "1" })).status === 404);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

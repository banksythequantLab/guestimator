// Run:  node worker/tests/soldinperson_test.mjs
// Scan the sticker, tap Sold: item marked sold, taken off eBay, counted once in the profit report.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { seal } from "../ebay.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 500) : ""}`)); };
const calls = [];
const jr = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (u, init = {}) => { const url = String(u); calls.push({ url, method: init.method || "GET" });
  if (/\/offer\/[^/]+\/withdraw$/.test(url)) return jr({ listingId: "L1" });
  return jr({ errors: [{ message: "unstubbed " + url }] }, 404); };
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, ASSETS: { fetch: async () => new Response("a") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", EBAY_CLIENT_ID: "c", EBAY_CLIENT_SECRET: "s", EBAY_RUNAME: "R",
  EBAY_TOKEN_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7)).toString("base64") };
let cookie = "";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const t = await r.text(); let json = null; try { json = JSON.parse(t); } catch {}
  return { status: r.status, json };
};
await call("POST", "/api/auth/register", { email: "d@example.com", password: "password123" });
const me = db.raw.prepare("SELECT id FROM users WHERE email='d@example.com'").get().id;
const t0 = new Date().toISOString();
db.raw.prepare("INSERT INTO ebay_accounts (user_id,ebay_user_id,ebay_username,refresh_token_enc,access_token_enc,access_expires_at,orders_synced_at,fulfillment_ok,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)")
  .run(me, "EU1", "d", await seal(env, "REF"), await seal(env, "ACC"), new Date(Date.now() + 3600e3).toISOString(), t0, t0, t0);
const mk = async name => (await call("POST", "/api/items", { name, description: name })).json.id;
const gpu = await mk("GPU"), lamp = await mk("Lamp"), vase = await mk("Vase");
db.raw.prepare("UPDATE items SET listing_status='live' WHERE id=?").run(gpu);
db.raw.prepare("INSERT INTO ebay_listings (id,item_id,user_id,sku,status,offer_id,listing_url,price_cents,created_at,updated_at) VALUES (?,?,?,?,'published','OFF-G','https://www.ebay.com/itm/1',8500,?,?)")
  .run(crypto.randomUUID(), gpu, me, "S-G", t0, t0);
await call("PUT", `/api/items/${gpu}/cost`, { cost: "30" });

ok("a price is required", (await call("POST", `/api/items/${gpu}/sold`, { price: "" })).status === 400);
let r = await call("POST", `/api/items/${gpu}/sold`, { price: "$75" });
ok("sold in person: recorded, off eBay", r.status === 200 && r.json.sold_cents === 7500 && r.json.ebay.ended === true && calls.some(c => /OFF-G\/withdraw$/.test(c.url)), r.json);
ok("item is sold; listing ended; cost kept", db.raw.prepare("SELECT listing_status s FROM items WHERE id=?").get(gpu).s === "sold"
  && db.raw.prepare("SELECT status s FROM ebay_listings WHERE item_id=?").get(gpu).s === "ended"
  && db.raw.prepare("SELECT cost_cents c, sold_cents p FROM item_finance WHERE item_id=?").get(gpu).c === 3000);
ok("can't sell it twice", (await call("POST", `/api/items/${gpu}/sold`, { price: "75" })).status === 409);
r = await call("POST", `/api/items/${lamp}/sold`, { price: "12.50" });
ok("not on eBay is fine", r.status === 200 && r.json.ebay.ended === false, r.json);

// on a sale page: marked sold there, counted once
const plus = d => new Date(Date.now() + d * 86400e3).toISOString().slice(0, 10);
const sid = (await call("POST", "/api/garage/sales", { title: "Yard", kind: "garage", city: "Montclair", state: "NJ", zip: "07042", street: "1 Elm", starts_on: plus(1), ends_on: plus(2), hours: "8-2", tz: "America/New_York" })).json.id;
await call("POST", `/api/garage/sales/${sid}/items`, { item_id: vase, price: "40" });
r = await call("POST", `/api/items/${vase}/sold`, { price: "35" });
ok("on a sale page it's marked sold there at the price taken", r.status === 200 && r.json.on_sale_page === true
  && db.raw.prepare("SELECT status s, price_cents p FROM garage_sale_items WHERE item_id=?").get(vase).p === 3500, r.json);

const rep = (await call("GET", "/api/profit")).json;
const row = id => rep.rows.filter(x => x.item_id === id);
ok("profit: GPU once, in person, $75 less $30 cost", row(gpu).length === 1 && row(gpu)[0].channel === "In person" && row(gpu)[0].profit_cents === 4500, row(gpu));
ok("profit: vase once, at the sale", row(vase).length === 1 && row(vase)[0].channel === "At the sale" && row(vase)[0].sale_cents === 3500, row(vase));
ok("profit: unsold stock excludes them", rep.inventory.items === 0, rep.inventory);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
// Run:  node worker/tests/nudges_test.mjs
// Price-drop nudges through the REAL routes and scheduled(), eBay stubbed at fetch(). Proves which
// listings are called slow, the suggested price, the eBay request, and the email throttle - NOT
// that eBay accepts the price update; that needs one real repricing.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as N from "../nudges.js";
import { seal } from "../ebay.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

// ---------- pure ----------
ok("10% off, whole dollars from $20", N.suggestLower(19900, 100) === 17900);
ok("50c steps under $20", N.suggestLower(1500, 5) === 1350);
ok("never below the estimate's low end", N.suggestLower(19900, 190) === 19000);
ok("already at the floor -> no nudge", N.suggestLower(19000, 190) === null);
ok("drop under a dollar -> no nudge", N.suggestLower(500, 0) === null && N.suggestLower(800, 0) === 700);
ok("no price -> no nudge", N.suggestLower(0, 0) === null && N.suggestLower(null) === null);

// ---------- eBay, stubbed ----------
const calls = []; let failUpdate = false;
const jr = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (u, init = {}) => {
  const url = String(u); const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ url, method: init.method || "GET", body });
  if (url.endsWith("/sell/inventory/v1/bulk_update_price_quantity")) return failUpdate
    ? jr({ responses: [{ statusCode: 400, errors: [{ longMessage: "The listing has ended." }] }] })
    : jr({ responses: [{ statusCode: 200, sku: body.requests[0].sku, offerId: body.requests[0].offers[0].offerId }] });
  if (url.includes("/sell/fulfillment/v1/order?")) return jr({ orders: [] });
  return jr({ errors: [{ message: "unstubbed " + url }] }, 404);
};

const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const mails = [];
const env = { DB: db, ASSETS: { fetch: async () => new Response("a") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", EBAY_CLIENT_ID: "c", EBAY_CLIENT_SECRET: "s", EBAY_RUNAME: "R",
  EBAY_TOKEN_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 3)).toString("base64"),
  EMAIL: { send: async m => { mails.push(m); return { messageId: "m" }; } } };
let cookie = "";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const t = await r.text(); let json = null; try { json = JSON.parse(t); } catch {}
  return { status: r.status, json };
};
await call("POST", "/api/auth/register", { email: "d@example.com", password: "password123" });
const me = db.raw.prepare("SELECT id FROM users WHERE email='d@example.com'").get().id;
const ago = d => new Date(Date.now() - d * 86400e3).toISOString();
const mkListing = async (name, priceCents, daysAgo, low) => {
  const id = (await call("POST", "/api/items", { name, description: name })).json.id;
  db.raw.prepare("UPDATE items SET listing_status='live', price_cents=? WHERE id=?").run(priceCents, id);
  db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)").run(crypto.randomUUID(), id, JSON.stringify({ price_range: { low } }), ago(40));
  const lid = crypto.randomUUID();
  db.raw.prepare("INSERT INTO ebay_listings (id,item_id,user_id,sku,status,offer_id,listing_id,listing_url,price_cents,created_at,updated_at) VALUES (?,?,?,?,'published',?,?,?,?,?,?)")
    .run(lid, id, me, "GUESS-" + id.replace(/-/g, ""), "OFF-" + name, "L-" + name, "https://www.ebay.com/itm/1", priceCents, ago(daysAgo), ago(daysAgo));
  return { id, lid };
};
const slow = await mkListing("Crock", 19900, 20, 100);
const fresh = await mkListing("Lamp", 5000, 3, 10);
const floor = await mkListing("Jug", 4000, 30, 40);

// no eBay account that can see sales -> nothing is called slow
let r = await call("GET", "/api/ebay/slow");
ok("no nudges while we can't see sales", r.status === 200 && r.json.listings.length === 0);
const t0 = new Date().toISOString();
db.raw.prepare("INSERT INTO ebay_accounts (user_id,ebay_user_id,ebay_username,refresh_token_enc,access_token_enc,access_expires_at,orders_synced_at,fulfillment_ok,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)")
  .run(me, "EU1", "d", await seal(env, "REF"), await seal(env, "ACC"), new Date(Date.now() + 3600e3).toISOString(), t0, t0, t0);

r = await call("GET", "/api/ebay/slow");
ok("only the 2-week-old listing with room to drop", r.json.listings.length === 1 && r.json.listings[0].id === slow.lid && r.json.listings[0].suggested_cents === 17900 && r.json.listings[0].days === 20, r.json);
ok("offer ids and SKUs stay server-side", !("offer_id" in r.json.listings[0]) && !("sku" in r.json.listings[0]));

ok("raising the price is refused", (await call("POST", `/api/ebay/slow/${slow.lid}/lower`, { price_cents: 25000 })).status === 400);
failUpdate = true;
r = await call("POST", `/api/ebay/slow/${slow.lid}/lower`, { price_cents: 17900 });
ok("eBay's refusal comes through, nothing changed here", r.status === 502 && /ended/.test(r.json.error) && db.raw.prepare("SELECT price_cents p FROM ebay_listings WHERE id=?").get(slow.lid).p === 19900);
failUpdate = false;
r = await call("POST", `/api/ebay/slow/${slow.lid}/lower`, { price_cents: 17900 });
const up = calls.filter(c => c.url.endsWith("bulk_update_price_quantity")).pop();
ok("price update sent for that offer", r.status === 200 && up.body.requests[0].offers[0].offerId === "OFF-Crock" && up.body.requests[0].offers[0].price.value === "179.00");
ok("new price saved, clock restarted", db.raw.prepare("SELECT price_cents p FROM ebay_listings WHERE id=?").get(slow.lid).p === 17900 &&
   db.raw.prepare("SELECT price_cents p FROM items WHERE id=?").get(slow.id).p === 17900 && (await call("GET", "/api/ebay/slow")).json.listings.length === 0);

// keep price hides it for two weeks
db.raw.prepare("UPDATE ebay_listings SET updated_at=? WHERE id=?").run(ago(15), slow.lid);
ok("slow again after two more weeks", (await call("GET", "/api/ebay/slow")).json.listings.length === 1);
ok("keep", (await call("POST", `/api/ebay/slow/${slow.lid}/keep`)).status === 200 && (await call("GET", "/api/ebay/slow")).json.listings.length === 0);

// digest email from the cron, once per two weeks
db.raw.prepare("UPDATE ebay_listings SET nudge_dismissed_at=NULL WHERE id=?").run(slow.lid);
db.raw.prepare("UPDATE ebay_accounts SET orders_synced_at=? WHERE user_id=?").run(new Date(Date.now() - 20 * 60e3).toISOString(), me);
await worker.scheduled({}, env, { waitUntil() {} });
const nudgeMails = () => mails.filter(m => /haven't sold|Still listed/.test(m.subject));
ok("seller gets one nudge email with the suggestion", nudgeMails().length === 1 && nudgeMails()[0].to === "d@example.com" && nudgeMails()[0].text.includes("$161.00"), mails.map(m => m.subject + " | " + m.text.slice(0, 200)));
await worker.scheduled({}, env, { waitUntil() {} });
ok("not emailed again within two weeks", nudgeMails().length === 1);
db.raw.prepare("UPDATE items SET listing_status='sold' WHERE id=?").run(slow.id);
db.raw.prepare("UPDATE ebay_listings SET nudge_emailed_at=? WHERE id=?").run(ago(20), slow.lid);
await worker.scheduled({}, env, { waitUntil() {} });
ok("sold items are never nudged", nudgeMails().length === 1 && (await call("GET", "/api/ebay/slow")).json.listings.length === 0);
ok("another user's listing can't be lowered", await (async () => { const c = cookie; cookie = ""; await call("POST", "/api/auth/register", { email: "x@example.com", password: "password123" });
  const s = (await call("POST", `/api/ebay/slow/${floor.lid}/lower`, { price_cents: 100 })).status; cookie = c; return s === 404; })());

// ---------- recent sales decide the suggestion when there are enough of them ----------
ok("well above the sold median -> suggest the median", JSON.stringify(N.nudgeFor(19900, 100, 5, 15900)) === JSON.stringify({ suggested_cents: 15900, basis: "sold", median_cents: 15900, sold_count: 5 }));
ok("sold median beats the estimate's floor", N.nudgeFor(19900, 180, 4, 12000).suggested_cents === 12000);
ok("in line with sales -> no cut", N.nudgeFor(16500, 100, 6, 15900) === null);
ok("below sales -> no cut", N.nudgeFor(9900, 50, 6, 15900) === null);
ok("too few sales -> the 10% rule", JSON.stringify(N.nudgeFor(19900, 100, 2, 12000)) === JSON.stringify({ suggested_cents: 17900, basis: "pct" }));
// through the route, from what a price check found earlier (no lookup on opening the screen)
const mkt = await mkListing("Pot", 19900, 20, 100);
const lamp2 = await mkListing("Vase", 16500, 20, 100);
db.raw.prepare("UPDATE ebay_listings SET sold_count=5, sold_median_cents=15200, sold_checked_at=? WHERE id=?").run(ago(1), mkt.lid);
db.raw.prepare("UPDATE ebay_listings SET sold_count=6, sold_median_cents=15900, sold_checked_at=? WHERE id=?").run(ago(1), lamp2.lid);
const before = calls.length;
const sv = (await call("GET", "/api/ebay/slow")).json.listings;
const pot = sv.find(x => x.id === mkt.lid);
ok("slow view: market-based suggestion with its evidence", pot && pot.suggested_cents === 15200 && pot.basis === "sold" && pot.sold_count === 5 && pot.sold_median_cents === 15200, pot);
ok("slow view: a listing already in line with sales is not nudged", !sv.some(x => x.id === lamp2.lid), sv.map(x => x.id));
ok("slow view spent no lookups", !calls.slice(before).some(c => /sold-comps/.test(c.url)));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

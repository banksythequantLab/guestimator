// Run:  node worker/tests/watchers_test.mjs
// Offers to interested buyers through the REAL routes, eBay's Negotiation API stubbed at fetch().
// Proves which listings qualify, the floor guard, the request eBay gets and the cooldown - NOT that
// eBay delivers the offer; that needs one real send.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { seal } from "../ebay.js";
import { discounted } from "../watchers.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 500) : ""}`)); };
ok("discount math", discounted(19900, 10) === 17910 && discounted(7900, 15) === 6715);

const calls = []; let eligible = ["111", "222"];
const jr = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (u, init = {}) => { const url = String(u); const body = typeof init.body === "string" ? JSON.parse(init.body) : null; calls.push({ url, method: init.method || "GET", body });
  if (url.includes("/sell/negotiation/v1/find_eligible_items")) return jr({ eligibleItems: eligible.map(listingId => ({ listingId })) });
  if (url.endsWith("/sell/negotiation/v1/send_offer_to_interested_buyers")) return jr({ offers: [{ offerId: "o1" }, { offerId: "o2" }] });
  return jr({ errors: [{ message: "unstubbed " + url }] }, 404); };
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, ASSETS: { fetch: async () => new Response("a") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", EBAY_CLIENT_ID: "c", EBAY_CLIENT_SECRET: "s", EBAY_RUNAME: "R",
  EBAY_TOKEN_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 9)).toString("base64") };
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
ok("not connected -> asked to connect", (await call("GET", "/api/ebay/interested")).status === 409);
db.raw.prepare("INSERT INTO ebay_accounts (user_id,ebay_user_id,ebay_username,refresh_token_enc,access_token_enc,access_expires_at,orders_synced_at,fulfillment_ok,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)")
  .run(me, "EU1", "d", await seal(env, "REF"), await seal(env, "ACC"), new Date(Date.now() + 3600e3).toISOString(), t0, t0, t0);
const mk = async (name, cents, listingId, extra = {}) => {
  const id = (await call("POST", "/api/items", { name, description: name })).json.id;
  db.raw.prepare("UPDATE items SET listing_status='live' WHERE id=?").run(id);
  if (extra.floor) db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)").run(crypto.randomUUID(), id, JSON.stringify({ price_range: { floor: extra.floor } }), t0);
  const lid = crypto.randomUUID();
  db.raw.prepare("INSERT INTO ebay_listings (id,item_id,user_id,sku,status,offer_id,listing_id,listing_url,price_cents,best_offer_min_cents,created_at,updated_at) VALUES (?,?,?,?,'published',?,?,?,?,?,?,?)")
    .run(lid, id, me, "S-" + name, "O-" + name, listingId, "https://www.ebay.com/itm/" + listingId, cents, extra.min ?? null, t0, t0);
  return lid;
};
const cisco = await mk("Cisco", 19900, "111", { min: 11500 });
const tesla = await mk("Tesla", 7900, "222", { floor: 68 });
const optane = await mk("Optane", 18000, "333");
db.raw.prepare("UPDATE ebay_listings SET best_offer_decline_cents=12600 WHERE id=?").run(optane);

let r = await call("GET", "/api/ebay/interested");
const by = Object.fromEntries((r.json.listings || []).map(l => [l.id, l]));
eligible.push("333"); const r2 = await call("GET", "/api/ebay/interested"); eligible.pop();
ok("no minimum set: the Best Offer decline line is the floor", r2.json.listings.find(l => l.id === optane).max_pct === 30, r2.json.listings);
ok("only listings eBay says have interested buyers", r.status === 200 && r.json.listings.length === 2 && !by[optane], r.json);
ok("max discount respects the seller's minimum", by[cisco].max_pct === 42 && by[tesla].max_pct === 13, [by[cisco].max_pct, by[tesla].max_pct]);

ok("over the floor refused", (await call("POST", `/api/ebay/listings/${tesla}/watcher-offer`, { pct: 15 })).status === 400);
ok("silly percent refused", (await call("POST", `/api/ebay/listings/${cisco}/watcher-offer`, { pct: 80 })).status === 400);
ok("nobody watching -> refused", (await call("POST", `/api/ebay/listings/${optane}/watcher-offer`, { pct: 10 })).status === 409);
r = await call("POST", `/api/ebay/listings/${cisco}/watcher-offer`, { pct: 10 });
const sent = calls.filter(c => c.url.endsWith("send_offer_to_interested_buyers")).pop();
ok("sent: eBay gets the listing, 10%, no counters, 2 days", r.status === 200 && r.json.sent === 2 && r.json.price_cents === 17910
  && sent.body.offeredItems[0].listingId === "111" && sent.body.offeredItems[0].discountPercentage === "10" && sent.body.allowCounterOffer === false && sent.body.offerDuration.value === 2, [r.json, sent && sent.body]);
r = await call("POST", `/api/ebay/listings/${cisco}/watcher-offer`, { pct: 10 });
ok("cooldown: not again for 3 days", r.status === 409 && /3 days/.test(r.json.error), r.json);
ok("listing shows the cooldown", (await call("GET", "/api/ebay/interested")).json.listings.find(l => l.id === cisco).wait_days === 3);
eligible = [];
ok("nobody interested -> empty list", (await call("GET", "/api/ebay/interested")).json.listings.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
// Run:  node worker/tests/market_buyers_test.mjs
// Market, buyer side and bulk listing (2026-10-06): put many items on at once, the seller's
// returns promise and "who's selling" box, and "Ask the seller a question" (emailed, reply-to buyer).
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

globalThis.fetch = async () => new Response("{}", { status: 404 });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const mails = [], pending = [];
const env = {
  DB: db, ASSETS: { fetch: async () => new Response("asset") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect",
  EMAIL: { send: async m => { mails.push(m); return { messageId: "m" + mails.length }; } },
};
const jar = { a: "", anon: "" }; let who = "a"; let ip = "203.0.113.1";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, redirect: "manual",
    headers: { "content-type": "application/json", cookie: jar[who], "cf-connecting-ip": ip }, body: body === undefined ? undefined : JSON.stringify(body) }),
    env, { waitUntil(p) { pending.push(p); } });
  while (pending.length) await pending.shift().catch(() => {});
  const sc = r.headers.get("set-cookie"); if (sc && who !== "anon") jar[who] = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

await call("POST", "/api/auth/register", { email: "a@example.com", password: "password123" });
const aId = db.raw.prepare("SELECT id FROM users WHERE email='a@example.com'").get().id;
const mkItem = async (name, result) => {
  const { json } = await call("POST", "/api/items", { name, description: name });
  if (result) db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)")
    .run(crypto.randomUUID(), json.id, JSON.stringify(result), new Date().toISOString());
  db.raw.prepare("UPDATE items SET ai_title=? WHERE id=?").run(name, json.id);
  return json.id;
};
const priced = s => ({ identification: { name: "x" }, price_range: { low: s / 2, high: s * 2, suggested_retail: s } });
const a = await mkItem("Oak chair", priced(60)), b2 = await mkItem("Tin sign", priced(25)), c = await mkItem("Quilt", priced(90));
await mkItem("No estimate yet", null);
await mkItem("Asked a question", { ...priced(10), needs_clarification: { question: "?" } });
const sold = await mkItem("Sold lamp", priced(30));
db.raw.prepare("UPDATE items SET listing_status='sold' WHERE id=?").run(sold);

// ---------- bulk ----------
let r = await call("GET", "/api/market/bulk");
const ids = (r.json.items || []).map(i => i.id);
ok("bulk: only priced, unsold, estimated items", r.status === 200 && ids.length === 3 && ids.includes(a) && ids.includes(b2) && ids.includes(c), r.json);
ok("bulk: price from the estimate", r.json.items.find(i => i.id === a).price_cents === 6000);
r = await call("POST", "/api/market/bulk", { items: [{ id: a, price: "60", ship: "20" }, { id: b2, price: "25", ship: "0" }, { id: c, price: "90" }, { id: "nope", price: "5", ship: "1" }] });
ok("bulk: lists the good ones, says why the rest didn't", r.status === 200 && r.json.listed === 2 && r.json.failed.length === 2 && r.json.new_shop === true && !!r.json.shop_id, r.json);
ok("bulk: one shop", db.raw.prepare("SELECT COUNT(*) n FROM garage_sales WHERE user_id=? AND kind='shop'").get(aId).n === 1);
r = await call("GET", "/api/market/bulk");
ok("bulk: listed items drop off the list", r.json.items.length === 1 && r.json.items[0].id === c);
ok("bulk: empty list refused", (await call("POST", "/api/market/bulk", { items: [] })).status === 400);

// ---------- returns + who's selling ----------
const shop = db.raw.prepare("SELECT * FROM garage_sales WHERE user_id=? AND kind='shop'").get(aId);
ok("returns: set on the shop", (await call("PATCH", `/api/garage/sales/${shop.id}`, { returns: "30", title: "Oak & Tin", city: "Austin", state: "TX" })).status === 200 &&
  db.raw.prepare("SELECT returns FROM garage_sales WHERE id=?").get(shop.id).returns === "30");
ok("returns: junk value cleared", (await call("PATCH", `/api/garage/sales/${shop.id}`, { returns: "forever" })).status === 200 &&
  db.raw.prepare("SELECT returns FROM garage_sales WHERE id=?").get(shop.id).returns === null);
await call("PATCH", `/api/garage/sales/${shop.id}`, { returns: "none" });
db.raw.prepare("UPDATE users SET connect_account_id='acct_A', stripe_payouts_ready=1 WHERE id=?").run(aId);
who = "anon";
r = await call("GET", `/sale/${shop.slug}/item/${a}`);
ok("item page: who's selling, since when", r.text.includes("Sold by Oak &amp; Tin") && /On Guestimator since [A-Z][a-z]+ \d{4}/.test(r.text));
ok("item page: returns promise", r.text.includes("No returns, unless it isn&#39;t as described"));
ok("item page: how paying works", r.text.includes("How paying works") && r.text.includes("takes no cut"));
ok("item page: ask box, no hold box", r.text.includes("Ask the seller a question") && !r.text.includes("Ask the seller to hold it"));

// ---------- ask the seller ----------
const ask = (body, from = ip) => { ip = from; return call("POST", "/api/public/market/ask", { sale: shop.slug, item: a, name: "Bea", email: "bea@buyer.test", message: "Any wobble?", ...body }); };
mails.length = 0;
r = await ask({});
ok("ask: accepted", r.status === 200 && r.json.ok, r.json);
const m = mails[0];
ok("ask: emailed to the seller, reply goes to the buyer", m && m.to === "a@example.com" && m.replyTo === "bea@buyer.test" && /Question about Oak chair/.test(m.subject) && m.text.includes("Any wobble?"), m);
ok("ask: stored and marked emailed", db.raw.prepare("SELECT emailed FROM market_questions").get().emailed === 1);
ok("ask: bad email refused", (await ask({ email: "nope" })).status === 400);
ok("ask: unknown shop", (await call("POST", "/api/public/market/ask", { sale: "nope", item: a, name: "B", email: "b@b.test", message: "hi there" })).status === 404);
for (let i = 0; i < 5; i++) await ask({}, "198.51.100.7");
ok("ask: 5 per hour per visitor", (await ask({}, "198.51.100.7")).status === 429);
ok("ask: other visitors still fine", (await ask({}, "198.51.100.8")).status === 200);
db.raw.prepare("UPDATE garage_sale_items SET status='sold' WHERE item_id=?").run(a);
ok("ask: sold item refused", (await ask({}, "198.51.100.9")).status === 409);
// a garage sale (not a shop) doesn't take questions this way
who = "a";
const gs = (await call("POST", "/api/garage/sales", { kind: "garage", title: "Yard", city: "Austin", state: "TX", starts_on: new Date().toISOString().slice(0, 10) })).json.id;
await call("POST", `/api/garage/sales/${gs}/items`, { item_id: c, price: "80" });
await call("PATCH", `/api/garage/sales/${gs}`, { status: "published" });
const gslug = db.raw.prepare("SELECT slug FROM garage_sales WHERE id=?").get(gs).slug;
who = "anon";
ok("ask: garage sales use holds instead", (await call("POST", "/api/public/market/ask", { sale: gslug, item: c, name: "B", email: "b@b.test", message: "hello" })).status === 404);

console.log(`market_buyers_test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

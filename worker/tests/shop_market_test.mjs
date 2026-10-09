// Run:  node worker/tests/shop_market_test.mjs
// Guestimator Market (2026-10-06): online shops (kind='shop' sales), the public /market page,
// zero platform fee on shop checkouts, and what the Market hides. Stripe is stubbed at fetch():
// this proves our wiring and bookkeeping, NOT that Stripe accepts the parameters.
import { d1 } from "./d1shim.mjs";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

const G = await import("../garage.js");
const M = await import("../market.js");

// ---------- pure ----------
ok("shop fee is 0", G.saleFee({ kind: "shop" }, 10000, 300) === 0);
ok("garage fee unchanged", G.saleFee({ kind: "garage" }, 10000, 300) === 300);
{
  const c = G.cleanSale({ kind: "shop", title: "My finds", city: "Austin", state: "tx", street: "1 Secret Ln", starts_on: "", ends_on: "2020-01-01", hours: "9-5" });
  ok("shop: no street, no hours, never ends", c.ok && c.value.street === null && c.value.hours === null && c.value.ends_on === G.SHOP_ENDS && /^\d{4}-\d{2}-\d{2}$/.test(c.value.starts_on), c);
}
ok("shop whenText", G.whenText({ kind: "shop", starts_on: "2026-01-01", ends_on: G.SHOP_ENDS }) === "Open now · buy any time");
ok("shop address never visible", !G.addressVisible({ kind: "shop", street: "x", starts_on: "2000-01-01", ends_on: G.SHOP_ENDS, tz: "America/New_York" }));
{
  const p = M.marketParams(new URLSearchParams("q=  red   wing &sort=bogus&page=-3"));
  ok("params normalised", p.q === "red wing" && p.sort === "new" && p.page === 1, p);
  const q = M.marketQuery({ q: "50%_off", sort: "low", page: 2 });
  ok("LIKE wildcards escaped", q.args[0] === "%50\\%\\_off%" && q.sql.includes("ESCAPE") && q.sql.includes("OFFSET 48") && q.sql.includes("price ASC"), q.args);
}

// ---------- Stripe, stubbed ----------
const calls = [];
const jr = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (u, init = {}) => {
  const url = String(u), method = init.method || "GET";
  const form = init.body instanceof URLSearchParams ? init.body : null;
  calls.push({ url, method, form, account: (init.headers || {})["stripe-account"] || null });
  if (url.endsWith("/v1/checkout/sessions")) return jr({ id: "cs_" + calls.length, url: "https://checkout.stripe.test/pay" });
  return jr({ error: { message: "unstubbed " + url } }, 404);
};
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const mails = [], pending = [];
const env = {
  DB: db, ASSETS: { fetch: async () => new Response("asset") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test",
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_platform", STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect",
  EMAIL: { send: async m => { mails.push(m); return { messageId: "m" + mails.length }; } },
};
const jar = { a: "", anon: "" }; let who = "a";
const call = async (method, path, body, extraHeaders = {}) => {
  const isForm = body instanceof URLSearchParams;
  const r = await worker.fetch(new Request("https://g.test" + path, { method, redirect: "manual",
    headers: { "content-type": isForm ? "application/x-www-form-urlencoded" : "application/json", cookie: jar[who], ...extraHeaders },
    body: body === undefined ? undefined : isForm ? body : typeof body === "string" ? body : JSON.stringify(body) }), env, { waitUntil(p) { pending.push(p); } });
  while (pending.length) await pending.shift().catch(() => {});
  const sc = r.headers.get("set-cookie"); if (sc && who !== "anon") jar[who] = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, location: r.headers.get("location") };
};
const sign = (body, secret) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`; };
const hook = ev => { const b = JSON.stringify(ev); return call("POST", "/api/public/garage/stripe-webhook", b, { "stripe-signature": sign(b, "whsec_connect") }); };

await call("POST", "/api/auth/register", { email: "a@example.com", password: "password123" });
const aId = db.raw.prepare("SELECT id FROM users WHERE email='a@example.com'").get().id;
const mkItem = async name => {
  const { json } = await call("POST", "/api/items", { name, description: name });
  db.raw.prepare("INSERT INTO photos (id,item_id,r2_key,kind,content_type,bytes,sort,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), json.id, `${json.id}/a.jpg`, "front", "image/jpeg", 10, 0, new Date().toISOString());
  db.raw.prepare("UPDATE items SET ai_title=? WHERE id=?").run(name, json.id);
  return json.id;
};
const crock = await mkItem("Red Wing crock"), lamp = await mkItem("Brass lamp"), vase = await mkItem("Garage vase");

// ---------- a shop ----------
let r = await call("POST", "/api/garage/sales", { kind: "shop", title: "A's finds", city: "Austin", state: "TX", street: "1 Secret Ln", ship_ok: true, online_ok: true, pickup_ok: false });
ok("shop created", r.status === 200 && r.json.id, r.json);
const shopId = r.json.id;
const shop = db.raw.prepare("SELECT * FROM garage_sales WHERE id=?").get(shopId);
ok("shop stored without street, never ends", shop.kind === "shop" && shop.street === null && shop.ends_on === "9999-12-31", shop);
await call("POST", `/api/garage/sales/${shopId}/items`, { item_id: crock, price: "135", ship: "12" });
await call("POST", `/api/garage/sales/${shopId}/items`, { item_id: lamp, price: "40" });   // no shipping price, pickup off
ok("publish shop", (await call("PATCH", `/api/garage/sales/${shopId}`, { status: "published" })).status === 200);
r = await call("GET", `/api/garage/sales/${shopId}`);
ok("seller sees 0% fee", r.json.payments.fee_bps === 0, r.json.payments);

// a garage sale with online buying: never on the Market
r = await call("POST", "/api/garage/sales", { kind: "garage", title: "Yard day", city: "Austin", state: "TX", starts_on: G.localDate(new Date(), "America/New_York"), ship_ok: true, online_ok: true });
const gsId = r.json.id;
await call("POST", `/api/garage/sales/${gsId}/items`, { item_id: vase, price: "20", ship: "8" });
await call("PATCH", `/api/garage/sales/${gsId}`, { status: "published" });

who = "anon";
r = await call("GET", "/market");
ok("market is public", r.status === 200 && r.text.includes("Guestimator Market") && r.text.includes("We take no cut"));
ok("nothing shown until the seller's Stripe is ready", !r.text.includes("Red Wing crock") && r.text.includes("Nothing for sale yet"));
db.raw.prepare("UPDATE users SET connect_account_id='acct_SELLER', stripe_payouts_ready=1 WHERE id=?").run(aId);
r = await call("GET", "/market");
ok("shop item with shipping is listed", r.text.includes("Red Wing crock") && r.text.includes("$135") && r.text.includes("+ $12 shipping") && r.text.includes("Austin, TX"));
ok("links to the item page", r.text.includes(`/sale/${shop.slug}/item/${crock}`));
ok("item that can't be shipped or picked up is hidden", !r.text.includes("Brass lamp"));
ok("garage-sale items are not on the Market", !r.text.includes("Garage vase"));
ok("search finds it", (await call("GET", "/market?q=wing")).text.includes("Red Wing crock"));
r = await call("GET", "/market?q=zebra%25");
ok("search miss says so, wildcard harmless", r.status === 200 && !r.text.includes("Red Wing crock") && r.text.includes("Nothing matches"));
ok("no Stripe on the server: empty, not an error", (await worker.fetch(new Request("https://g.test/market"), { ...env, STRIPE_SECRET_KEY: "" }, { waitUntil() {} })).status === 200);

r = await call("GET", "/api/public/garage/sales");
ok("directory feed leaves shops out", r.status === 200 && !JSON.stringify(r.json).includes("A's finds") && JSON.stringify(r.json).includes("Yard day"));

r = await call("GET", `/sale/${shop.slug}`);
ok("shop page: ships from city, no street, links to Market", r.text.includes("Ships from Austin, TX") && !r.text.includes("Secret Ln") && r.text.includes('href="/market"'));
r = await call("GET", `/sale/${shop.slug}/item/${crock}`);
ok("shop item page: buy box, no hold box, says no cut", r.text.includes("Pay securely with Stripe") && !r.text.includes("Ask the seller to hold it") && r.text.includes("Guestimator takes no cut"));

// ---------- checkout: no application fee ----------
const buy = () => call("POST", "/api/public/garage/checkout", new URLSearchParams({ sale: shop.slug, item: crock, fulfilment: "ship" }));
r = await buy();
ok("checkout redirects to Stripe", r.status === 303 && r.location === "https://checkout.stripe.test/pay", { status: r.status, location: r.location });
let sc = calls.filter(c => c.url.endsWith("/v1/checkout/sessions")).pop();
ok("direct charge on the seller's account", sc.account === "acct_SELLER");
ok("no application fee sent", !sc.form.has("payment_intent_data[application_fee_amount]"), [...sc.form.keys()]);
ok("item + shipping charged", sc.form.get("line_items[0][price_data][unit_amount]") === "13500" && sc.form.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]") === "1200");
let order = db.raw.prepare("SELECT * FROM garage_orders WHERE sale_id=? ORDER BY created_at DESC").get(shopId);
ok("order records fee 0", order.fee_cents === 0 && order.total_cents === 14700, order);
ok("being bought: off the Market", !(await call("GET", "/market")).text.includes("Red Wing crock"));

// abandoned checkout comes back on the Market by itself
db.raw.prepare("UPDATE garage_orders SET created_at=? WHERE id=?").run(new Date(Date.now() - 3600e3).toISOString(), order.id);
ok("abandoned checkout released by the Market", (await call("GET", "/market")).text.includes("Red Wing crock"));
ok("abandoned order cancelled", db.raw.prepare("SELECT status FROM garage_orders WHERE id=?").get(order.id).status === "cancelled");

// Market terms live (2026-10-08): a buyer ticks "I agree" before paying (clickwrap)
{
  const { TERMS_VERSION } = await import("../terms.js");
  env.MARKET_TERMS_LIVE = "on";
  const pg = await call("GET", `/sale/${shop.slug}/item/${crock}`);
  ok("terms live: buy box has a required agree box", pg.text.includes('name="agree" value="1" required') && pg.text.includes('href="/market-terms"'));
  const n0 = calls.filter(c => c.url.endsWith("/v1/checkout/sessions")).length;
  const no = await buy();
  ok("no tick: no checkout, item not reserved", no.status === 400 && calls.filter(c => c.url.endsWith("/v1/checkout/sessions")).length === n0
    && db.raw.prepare("SELECT status FROM garage_sale_items WHERE item_id=?").get(crock).status === "available", no.status);
  const yes = await call("POST", "/api/public/garage/checkout", new URLSearchParams({ sale: shop.slug, item: crock, fulfilment: "ship", agree: "1" }));
  const s2 = calls.filter(c => c.url.endsWith("/v1/checkout/sessions")).pop();
  ok("ticked: checkout, version recorded on the payment", yes.status === 303 && s2.form.get("metadata[market_terms]") === TERMS_VERSION && s2.form.get("payment_intent_data[metadata][market_terms]") === TERMS_VERSION, [...s2.form.entries()].filter(([k]) => /terms/.test(k)));
  const o2 = db.raw.prepare("SELECT id FROM garage_orders WHERE sale_id=? ORDER BY created_at DESC").get(shopId);
  db.raw.prepare("UPDATE garage_orders SET created_at=? WHERE id=?").run(new Date(Date.now() - 3600e3).toISOString(), o2.id);
  await call("GET", "/market");
  env.MARKET_TERMS_LIVE = "";
  ok("terms off: no agree box", !(await call("GET", `/sale/${shop.slug}/item/${crock}`)).text.includes('name="agree"'));
}

// "Sold as is" (2026-10-09): conspicuous in the buy box, only when the shop chose it
{
  db.raw.prepare("UPDATE garage_sales SET returns='asis' WHERE id=?").run(shopId);
  const pg = await call("GET", `/sale/${shop.slug}/item/${crock}`);
  ok("as is: boxed SOLD AS IS in the buy box, merchantability named", /Buy it now<\/b><div style="border:2px solid[^"]*"><b[^>]*>SOLD AS IS, WITH ALL FAULTS/.test(pg.text) && pg.text.includes("merchantability") && pg.text.includes("Sold as is: no returns and no implied warranties"));
  db.raw.prepare("UPDATE garage_sales SET returns='30' WHERE id=?").run(shopId);
  ok("not as is: no banner", !(await call("GET", `/sale/${shop.slug}/item/${crock}`)).text.includes("SOLD AS IS"));
}
// garage sale checkout: no fee either, by default (Guestimator lists, it takes no cut)
r = await call("POST", "/api/public/garage/checkout", new URLSearchParams({ sale: db.raw.prepare("SELECT slug FROM garage_sales WHERE id=?").get(gsId).slug, item: vase, fulfilment: "ship" }));
sc = calls.filter(c => c.url.endsWith("/v1/checkout/sessions")).pop();
ok("garage sale checkout has no fee by default", r.status === 303 && !sc.form.has("payment_intent_data[application_fee_amount]"), sc.form.get("payment_intent_data[application_fee_amount]"));

// paid
await buy();
order = db.raw.prepare("SELECT * FROM garage_orders WHERE sale_id=? AND status='pending'").get(shopId);
r = await hook({ type: "checkout.session.completed", data: { object: { id: order.stripe_session_id, payment_status: "paid", payment_intent: "pi_1",
  customer_details: { name: "Buyer", email: "buyer@example.com" }, collected_information: { shipping_details: { name: "Buyer", address: { line1: "1 A", city: "X", state: "TX", postal_code: "78701", country: "US" } } } } } });
ok("webhook accepted", r.status === 200, r.json);
ok("order paid", db.raw.prepare("SELECT status FROM garage_orders WHERE id=?").get(order.id).status === "paid");
ok("sold: off the Market", !(await call("GET", "/market")).text.includes("Red Wing crock"));
who = "a";
ok("seller sees the order with nothing kept back", (await call("GET", `/api/garage/sales/${shopId}`)).json.orders.some(o => o.id === order.id && o.fee_cents === 0));

console.log(`shop_market_test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

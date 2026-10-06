// Run:  node worker/tests/market_onetap_test.mjs
// One-tap "Sell on the Market" (market.sellerApi), never selling the same thing twice
// (pullOtherCopies), the sitemap, Market view counts, and "Buy this one" on share pages.
// Stripe is stubbed at fetch(); nothing here proves Stripe accepts the parameters.
import { d1 } from "./d1shim.mjs";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

const calls = [];
const jr = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (u, init = {}) => {
  const url = String(u);
  calls.push({ url, form: init.body instanceof URLSearchParams ? init.body : null });
  if (url.endsWith("/v1/checkout/sessions")) return jr({ id: "cs_" + calls.length, url: "https://checkout.stripe.test/pay" });
  return jr({ error: { message: "unstubbed " + url } }, 404);
};
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const pending = [];
const env = {
  DB: db, ASSETS: { fetch: async () => new Response("asset") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect",
  EMAIL: { send: async () => ({ messageId: "m" }) },
};
const jar = { a: "", b: "", anon: "" }; let who = "a";
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
const hook = ev => { const b = JSON.stringify(ev), t = Math.floor(Date.now() / 1000);
  return call("POST", "/api/public/garage/stripe-webhook", b, { "stripe-signature": `t=${t},v1=${createHmac("sha256", "whsec_connect").update(`${t}.${b}`).digest("hex")}` }); };

await call("POST", "/api/auth/register", { email: "a@example.com", password: "password123" });
who = "b"; await call("POST", "/api/auth/register", { email: "b@example.com", password: "password123" }); who = "a";
const aId = db.raw.prepare("SELECT id FROM users WHERE email='a@example.com'").get().id;
const mkItem = async (name, suggested) => {
  const { json } = await call("POST", "/api/items", { name, description: name });
  db.raw.prepare("INSERT INTO photos (id,item_id,r2_key,kind,content_type,bytes,sort,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), json.id, `${json.id}/a.jpg`, "front", "image/jpeg", 10, 0, new Date().toISOString());
  db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)").run(crypto.randomUUID(), json.id,
    JSON.stringify({ identification: { name }, price_range: { low: suggested / 2, high: suggested * 1.5, suggested_retail: suggested }, listing: { title: name },
      shipping: { box_in: [12, 9, 6], packed_weight_lb: 3 } }), new Date().toISOString());
  db.raw.prepare("UPDATE items SET ai_title=? WHERE id=?").run(name, json.id);
  return json.id;
};
const crock = await mkItem("Red Wing crock", 135), lamp = await mkItem("Brass lamp", 40), clock = await mkItem("Mantel clock", 80);

// ---------- one tap ----------
let r = await call("GET", `/api/market/items/${crock}`);
ok("first look: no shop, price from the estimate, size known", r.status === 200 && r.json.shop === null && r.json.listed === null && r.json.price_cents === 13500 && r.json.has_size === true, r.json);
ok("stripe status included", r.json.stripe && r.json.stripe.platform_on === true && r.json.stripe.ready === false);
who = "b"; ok("someone else's item: 404", (await call("GET", `/api/market/items/${crock}`)).status === 404); who = "a";
ok("price below $1 refused", (await call("POST", `/api/market/items/${crock}`, { price: "0.5", ship: "12" })).status === 400);
ok("shipping required", (await call("POST", `/api/market/items/${crock}`, { price: "135" })).status === 400);
ok("a refused listing makes no shop", !db.raw.prepare("SELECT 1 FROM garage_sales WHERE user_id=? AND kind='shop'").get(aId));
// A saved ship-from address gives the quiet shop its location.
db.raw.prepare("INSERT INTO seller_settings (user_id, ship_from, updated_at) VALUES (?,?,?)").run(aId, JSON.stringify({ name: "A", street1: "1 Main", city: "Austin", state: "tx", zip: "78701" }), new Date().toISOString());
r = await call("POST", `/api/market/items/${crock}`, { price: "135", ship: "12" });
ok("no setup step: price + shipping lists it", r.status === 200 && r.json.ok && /\/sale\/guestimator-seller-[0-9a-f]{6}\/item\//.test(r.json.url), r.json);
ok("then the app is told to offer a sale/shop setup", r.json.new_shop === true && !!r.json.shop_id);
ok("not visible until Stripe is ready", r.json.visible === false);
const shop = db.raw.prepare("SELECT * FROM garage_sales WHERE user_id=? AND kind='shop'").get(aId);
ok("quiet shop: published, ships only, never ends, located from ship-from", shop.status === "published" && shop.ship_ok === 1 && shop.pickup_ok === 0 && shop.online_ok === 1 && shop.ends_on === "9999-12-31" && shop.city === "Austin" && shop.state === "TX" && shop.zip === "78701" && shop.title === "Guestimator seller", shop);
r = await call("GET", `/api/market/items/${crock}`);
ok("now shows as listed", r.json.listed && r.json.listed.price_cents === 13500 && r.json.listed.ship_cents === 1200 && r.json.listed.status === "available" && r.json.from_zip === "78701", r.json);
ok("second item: shipping still required", (await call("POST", `/api/market/items/${lamp}`, { price: "40" })).status === 400);
r = await call("POST", `/api/market/items/${lamp}`, { price: "40", ship: "0" });
ok("second item listed, no offer again", r.json.ok && r.json.new_shop === false && r.json.needs_setup === false, r.json);
ok("still one shop", db.raw.prepare("SELECT COUNT(*) n FROM garage_sales WHERE user_id=? AND kind='shop'").get(aId).n === 1);
ok("change the price", (await call("POST", `/api/market/items/${crock}`, { price: "125", ship: "12" })).json.ok &&
  db.raw.prepare("SELECT price_cents FROM garage_sale_items WHERE sale_id=? AND item_id=?").get(shop.id, crock).price_cents === 12500);
ok("take it off", (await call("DELETE", `/api/market/items/${lamp}`)).json.ok && !db.raw.prepare("SELECT 1 FROM garage_sale_items WHERE item_id=?").get(lamp));
await call("POST", `/api/market/items/${lamp}`, { price: "40", ship: "0" });

// ---------- Market, views, sitemap, share page ----------
db.raw.prepare("UPDATE users SET connect_account_id='acct_SELLER', stripe_payouts_ready=1 WHERE id=?").run(aId);
who = "anon";
r = await call("GET", "/market");
ok("listed items on the Market", r.text.includes("Red Wing crock") && r.text.includes("$125") && r.text.includes("Free shipping"));
await call("GET", "/market");
ok("views counted per day", db.raw.prepare("SELECT views FROM market_views WHERE day=?").get(new Date().toISOString().slice(0, 10)).views === 2);
r = await call("GET", "/sitemap.xml");
ok("sitemap lists the Market and its items", r.status === 200 && r.text.includes("https://g.test/market<") && r.text.includes(`/sale/${shop.slug}/item/${crock}`), r.text.slice(0, 300));
who = "a";
const share = (await call("POST", `/api/items/${crock}/share`)).json;
who = "anon";
r = await call("GET", new URL(share.url).pathname);
ok("share page sells it", r.text.includes("Buy this one · $125") && r.text.includes(`/sale/${shop.slug}/item/${crock}`));

// ---------- never sold twice ----------
who = "a";
// The clock is in a garage sale AND in the shop.
r = await call("POST", "/api/garage/sales", { kind: "garage", title: "Yard day", city: "Austin", state: "TX", starts_on: new Date().toISOString().slice(0, 10) });
const gs = r.json.id;
await call("POST", `/api/garage/sales/${gs}/items`, { item_id: clock, price: "70" });
await call("POST", `/api/market/items/${clock}`, { price: "80", ship: "15" });
ok("clock in two places", db.raw.prepare("SELECT COUNT(*) n FROM garage_sale_items WHERE item_id=?").get(clock).n === 2);
await call("PATCH", `/api/garage/sales/${gs}/items/${clock}`, { status: "sold" });
ok("sold at the garage sale: off the shop, counted once", db.raw.prepare("SELECT sale_id, status FROM garage_sale_items WHERE item_id=?").all(clock).length === 1 &&
  db.raw.prepare("SELECT status FROM garage_sale_items WHERE item_id=?").get(clock).status === "sold");
who = "anon"; ok("and gone from the Market", !(await call("GET", "/market")).text.includes("Mantel clock")); who = "a";

// Sold in person (item screen): shop copy goes.
await call("POST", `/api/garage/sales/${gs}/items`, { item_id: lamp, price: "35" });
r = await call("POST", `/api/items/${lamp}/sold`, { price: "35" });
ok("sold in person: ok", r.status === 200, r.json);
ok("sold in person: recorded on the garage sale, off the shop", db.raw.prepare("SELECT sale_id FROM garage_sale_items WHERE item_id=?").all(lamp).map(x => x.sale_id).join() === gs);

// Bought on the Market while also in a garage sale: the garage copy goes, item marked sold.
await call("POST", `/api/garage/sales/${gs}/items`, { item_id: crock, price: "120" });
who = "anon";
r = await call("POST", "/api/public/garage/checkout", new URLSearchParams({ sale: shop.slug, item: crock, fulfilment: "ship" }));
ok("checkout opened", r.status === 303, r);
const order = db.raw.prepare("SELECT * FROM garage_orders WHERE sale_id=? AND item_id=?").get(shop.id, crock);
r = await hook({ type: "checkout.session.completed", data: { object: { id: order.stripe_session_id, payment_status: "paid", payment_intent: "pi_1", customer_details: { name: "B", email: "b@x.com" } } } });
ok("paid", db.raw.prepare("SELECT status FROM garage_orders WHERE id=?").get(order.id).status === "paid");
ok("garage copy pulled", db.raw.prepare("SELECT sale_id FROM garage_sale_items WHERE item_id=?").all(crock).map(x => x.sale_id).join() === shop.id);
ok("item marked sold", db.raw.prepare("SELECT listing_status FROM items WHERE id=?").get(crock).listing_status === "sold");
who = "a";
r = await call("GET", `/api/market/items/${crock}`);
ok("seller sees it sold", r.json.listed.status === "sold");
ok("can't relist a sold item", (await call("POST", `/api/market/items/${crock}`, { price: "100", ship: "5" })).status === 409);

// A paying buyer whose copy was pulled (sold elsewhere meanwhile) is flagged for a refund, not sold twice.
const vase = await mkItem("Glass vase", 30);
await call("POST", `/api/garage/sales/${gs}/items`, { item_id: vase, price: "25" });
await call("POST", `/api/market/items/${vase}`, { price: "30", ship: "6" });
who = "anon";
await call("POST", "/api/public/garage/checkout", new URLSearchParams({ sale: shop.slug, item: vase, fulfilment: "ship" }));
who = "a";
await call("PATCH", `/api/garage/sales/${gs}/items/${vase}`, { status: "sold" });
const vo = db.raw.prepare("SELECT * FROM garage_orders WHERE item_id=?").get(vase);
await hook({ type: "checkout.session.completed", data: { object: { id: vo.stripe_session_id, payment_status: "paid", payment_intent: "pi_2", customer_details: { name: "C", email: "c@x.com" } } } });
ok("late payment after an in-person sale: refund_needed", db.raw.prepare("SELECT status FROM garage_orders WHERE id=?").get(vo.id).status === "refund_needed");

// A seller with no saved address: still one tap, no location shown anywhere, setup offered.
who = "b";
const bId = db.raw.prepare("SELECT id FROM users WHERE email='b@example.com'").get().id;
const teapot = await mkItem("Silver teapot", 60);
r = await call("POST", `/api/market/items/${teapot}`, { price: "60", ship: "9" });
ok("no address: listed anyway, setup offered", r.json.ok && r.json.new_shop === true && r.json.needs_setup === true, r.json);
db.raw.prepare("UPDATE users SET connect_account_id='acct_B', stripe_payouts_ready=1 WHERE id=?").run(bId);
const bShop = db.raw.prepare("SELECT slug FROM garage_sales WHERE user_id=? AND kind='shop'").get(bId);
who = "anon";
r = await call("GET", "/market?q=teapot");
ok("no-location item on the Market, no stray comma", r.text.includes("Silver teapot") && !r.text.includes(">, <"), r.text.match(/Silver teapot[^]{0,400}/)?.[0]);
r = await call("GET", `/sale/${bShop.slug}/item/${teapot}`);
ok("no-location shop page: Ships to you, no empty place", r.status === 200 && r.text.includes("Ships to you") && !r.text.includes(" in , ") && !r.text.includes("Online shop in"));

console.log(`market_onetap_test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

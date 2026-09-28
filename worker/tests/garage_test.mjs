// Run:  node worker/tests/garage_test.mjs
// Garage / estate sales through the REAL worker routes against the node:sqlite D1 shim with every
// migration applied. Stripe is stubbed at fetch(): this proves our wiring, reservations and money
// bookkeeping, NOT that Stripe accepts these parameters - that needs a test-mode run.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHmac } from "node:crypto";
import * as G from "../garage.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.log(`FAIL ${n}`)); };

// ---------- pure helpers ----------
ok("localDate in zone", G.localDate(new Date("2026-10-03T03:30:00Z"), "America/New_York") === "2026-10-02");
ok("localDate bad zone falls back", G.localDate(new Date("2026-10-03T12:00:00Z"), "Not/AZone") === "2026-10-03");
const s0 = { starts_on: "2026-10-03", ends_on: "2026-10-04", tz: "America/New_York", street: "12 Elm St" };
ok("phase upcoming", G.phase(s0, new Date("2026-10-02T15:00:00Z")) === "upcoming");
ok("phase open first day", G.phase(s0, new Date("2026-10-03T15:00:00Z")) === "open");
ok("phase open, late on the last day local time", G.phase(s0, new Date("2026-10-05T02:00:00Z")) === "open");
ok("phase ended", G.phase(s0, new Date("2026-10-05T15:00:00Z")) === "ended");
ok("street hidden before the sale", !G.addressVisible(s0, new Date("2026-10-02T23:00:00Z")));
ok("street shown on the day", G.addressVisible(s0, new Date("2026-10-03T04:30:00Z")));
ok("fee 3%", G.feeCents(10000, 300) === 300 && G.feeCents(1999, "300") === 60);
ok("fee capped at 20%", G.feeCents(10000, 5000) === 2000);
ok("cents", G.cents("$1,250.5") === 125050 && G.cents("") === null && Number.isNaN(G.cents("abc")) && Number.isNaN(G.cents("-3")));
ok("onlinePrice falls back to tag", G.onlinePrice({ price_cents: 500, online_price_cents: null }) === 500 && G.onlinePrice({ price_cents: 500, online_price_cents: 650 }) === 650);
ok("stripeForm nests", G.stripeForm({ a: { b: { 0: { c: 1 } } }, d: null, e: "x" }).toString() === "a%5Bb%5D%5B0%5D%5Bc%5D=1&e=x");
{
  const c = G.cleanSale({ title: "Big Sale", city: "Montclair", state: "nj", starts_on: "2026-10-03", ends_on: "2026-10-02" });
  ok("end before start refused", !c.ok);
  ok("state validated", !G.cleanSale({ title: "x", city: "y", state: "ZZ", starts_on: "2026-10-03" }).ok);
  const d = G.cleanSale({ title: "Big Sale", city: "Montclair", state: "nj", starts_on: "2026-10-03" });
  ok("end defaults to start, state uppercased", d.ok && d.value.ends_on === "2026-10-03" && d.value.state === "NJ");
}
ok("accountReady needs card payments + charges enabled",
   G.accountReady({ charges_enabled: true, capabilities: { card_payments: "active" }, details_submitted: true }) &&
   !G.accountReady({ charges_enabled: false, capabilities: { card_payments: "active" }, details_submitted: true }) &&
   !G.accountReady({ charges_enabled: true, capabilities: { transfers: "active" }, details_submitted: true }));
ok("stripeReady with only the Connect webhook secret", G.stripeReady({ STRIPE_SECRET_KEY: "k", STRIPE_CONNECT_WEBHOOK_SECRET: "c" }) && !G.stripeReady({ STRIPE_SECRET_KEY: "k" }));
{
  const body = '{"x":1}', t = 1790000000;
  const sig = createHmac("sha256", "whsec_a").update(`${t}.${body}`).digest("hex");
  ok("sig ok with second secret", await G.verifyStripeSig([undefined, "whsec_a"], body, `t=${t},v1=${sig}`, t + 10));
  ok("sig rejects stale", !(await G.verifyStripeSig(["whsec_a"], body, `t=${t},v1=${sig}`, t + 1000)));
  ok("sig rejects tamper", !(await G.verifyStripeSig(["whsec_a"], '{"x":2}', `t=${t},v1=${sig}`, t + 10)));
}

// ---------- Stripe, stubbed ----------
const calls = [];
let acctReady = false;
const jr = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (u, init = {}) => {
  const url = String(u), method = init.method || "GET";
  const form = init.body instanceof URLSearchParams ? init.body : null;
  calls.push({ url, method, form, account: (init.headers || {})["stripe-account"] || null });
  if (url.endsWith("/v1/accounts") && method === "POST") return jr({ id: "acct_SELLER" });
  if (url.includes("/v1/accounts/acct_SELLER") && url.endsWith("/login_links")) return jr({ url: "https://connect.stripe.test/express" });
  if (url.includes("/v1/accounts/acct_SELLER") && method === "GET")
    return jr({ id: "acct_SELLER", details_submitted: acctReady, charges_enabled: acctReady, capabilities: { card_payments: acctReady ? "active" : "inactive", transfers: acctReady ? "active" : "inactive" }, requirements: { currently_due: acctReady ? [] : ["external_account"] } });
  if (url.endsWith("/v1/account_links")) return jr({ url: "https://connect.stripe.test/onboard" });
  if (url.endsWith("/v1/checkout/sessions")) return jr({ id: "cs_" + calls.length, url: "https://checkout.stripe.test/pay" });
  return jr({ error: { message: "unstubbed " + url } }, 404);
};

const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = {
  DB: db, ASSETS: { fetch: async () => new Response("asset") },
  PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", GARAGE_FEE_BPS: "300",
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_platform", STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect",
};
const jar = { a: "", b: "", anon: "" };
let who = "a";
const call = async (method, path, body, extraHeaders = {}) => {
  const isForm = body instanceof URLSearchParams;
  const r = await worker.fetch(new Request("https://g.test" + path, {
    method, redirect: "manual",
    headers: { ...(isForm ? { "content-type": "application/x-www-form-urlencoded" } : { "content-type": "application/json" }), cookie: jar[who], "cf-connecting-ip": "203.0.113.9", ...extraHeaders },
    body: body === undefined ? undefined : isForm ? body : typeof body === "string" ? body : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc && who !== "anon") jar[who] = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, location: r.headers.get("location") };
};
const sign = (body, secret) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`; };
const hook = (ev, secret = "whsec_platform") => { const b = JSON.stringify(ev); return call("POST", "/api/public/garage/stripe-webhook", b, { "stripe-signature": sign(b, secret) }); };

// ---------- two sellers, items ----------
ok("register a", (await call("POST", "/api/auth/register", { email: "a@example.com", password: "password123" })).status === 200);
who = "b"; ok("register b", (await call("POST", "/api/auth/register", { email: "b@example.com", password: "password123" })).status === 200);
who = "a";
const aId = db.raw.prepare("SELECT id FROM users WHERE email='a@example.com'").get().id;
const mkItem = async (name, suggested) => {
  const { json } = await call("POST", "/api/items", { name, description: name });
  db.raw.prepare("INSERT INTO photos (id,item_id,r2_key,kind,content_type,bytes,sort,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), json.id, `${json.id}/a.jpg`, "front", "image/jpeg", 10, 0, new Date().toISOString());
  if (suggested) db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)")
    .run(crypto.randomUUID(), json.id, JSON.stringify({ price_range: { low: 1, high: 2, suggested_retail: suggested }, listing: { title: name } }), new Date().toISOString());
  db.raw.prepare("UPDATE items SET ai_title=? WHERE id=?").run(name + " (AI title)", json.id);
  return json.id;
};
const crock = await mkItem("Red Wing crock", 135), lamp = await mkItem("Brass lamp", 40), cheap = await mkItem("Coffee mug", 0);
who = "b"; const bItem = await mkItem("B's vase", 20); who = "a";

// ---------- create / edit / publish ----------
const today = G.localDate(new Date(), "America/New_York");
const plus = n => G.localDate(new Date(Date.now() + n * 86400e3), "America/New_York");
let r = await call("POST", "/api/garage/sales", { title: "Elm St Estate Sale", kind: "estate", city: "Montclair", state: "NJ", zip: "07042", street: "12 Elm St", starts_on: plus(3), ends_on: plus(4), hours: "8am-2pm", tz: "America/New_York" });
ok("create sale", r.status === 200 && r.json.id);
const sid = r.json.id;
ok("bad sale refused", (await call("POST", "/api/garage/sales", { title: "", city: "x", state: "NJ", starts_on: today })).status === 400);
ok("cannot publish empty sale", (await call("PATCH", `/api/garage/sales/${sid}`, { status: "published" })).status === 409);
r = await call("POST", `/api/garage/sales/${sid}/items`, { item_id: crock });
ok("price defaults to the estimate's suggested retail", r.status === 200 && r.json.price_cents === 13500);
ok("add lamp with prices", (await call("POST", `/api/garage/sales/${sid}/items`, { item_id: lamp, price: "40", online_price: "52", ship: "12.50" })).status === 200);
ok("add mug at $0.50", (await call("POST", `/api/garage/sales/${sid}/items`, { item_id: cheap, price: "0.50" })).status === 200);
ok("someone else's item refused", (await call("POST", `/api/garage/sales/${sid}/items`, { item_id: bItem })).status === 404);
ok("bad price refused", (await call("PATCH", `/api/garage/sales/${sid}/items/${lamp}`, { online_price: "abc" })).status === 400);
const slug = db.raw.prepare("SELECT slug FROM garage_sales WHERE id=?").get(sid).slug;
who = "anon"; ok("draft hidden from the public", (await call("GET", `/sale/${slug}`)).status === 404); who = "a";
ok("draft visible to its owner", (await call("GET", `/sale/${slug}`)).status === 200);
who = "b"; ok("other seller can't read the sale", (await call("GET", `/api/garage/sales/${sid}`)).status === 404);
ok("other seller can't edit it", (await call("PATCH", `/api/garage/sales/${sid}`, { title: "mine" })).status === 404); who = "a";
ok("publish", (await call("PATCH", `/api/garage/sales/${sid}`, { status: "published", ship_ok: true })).status === 200);

// ---------- public page: address privacy ----------
who = "anon";
r = await call("GET", `/sale/${slug}`);
ok("public page lists items", r.status === 200 && r.text.includes("Red Wing crock (AI title)") && r.text.includes("$135"));
ok("street hidden before sale day", !r.text.includes("12 Elm St") && r.text.includes("Montclair"));
ok("no buy option without Stripe connected", !r.text.includes("Buy online"));
r = await call("GET", `/api/public/garage/sales?state=nj&city=montclair`);
ok("feed lists the sale", r.status === 200 && r.json.sales.length === 1 && r.json.sales[0].title === "Elm St Estate Sale");
ok("feed never includes the street", !JSON.stringify(r.json).includes("Elm St,") && !JSON.stringify(r.json).includes("12 Elm"));
{
  const raw = await worker.fetch(new Request("https://g.test/api/public/garage/sales?state=NJ"), env, { waitUntil() {} });
  ok("feed is CORS-open and cacheable", raw.headers.get("access-control-allow-origin") === "*" && /max-age=300/.test(raw.headers.get("cache-control")));
}
db.raw.prepare("UPDATE garage_sales SET starts_on=? WHERE id=?").run(today, sid);
r = await call("GET", `/sale/${slug}`);
ok("street shown on sale day", r.text.includes("12 Elm St"));
who = "a";
ok("tags need the owner", (await (async () => { who = "anon"; const x = await call("GET", `/sale/${slug}/tags`); who = "a"; return x.status; })()) === 403);
r = await call("GET", `/sale/${slug}/tags`);
ok("tags render for owner with QR target", r.status === 200 && r.text.includes(`/sale/${slug}/item/${crock}`) && r.text.includes("/vendor/qrcode.js"));

// ---------- holds ----------
who = "anon";
r = await call("POST", "/api/public/garage/hold", { sale: slug, item: crock, name: "Pat", phone: "973-555-0101", note: "Saturday 9am" });
ok("hold request", r.status === 200);
ok("hold needs a phone", (await call("POST", "/api/public/garage/hold", { sale: slug, item: crock, name: "Pat", phone: "12" })).status === 400);
for (let i = 0; i < 4; i++) await call("POST", "/api/public/garage/hold", { sale: slug, item: lamp, name: "Spam", phone: "5555555555" });
ok("holds rate-limited per IP", (await call("POST", "/api/public/garage/hold", { sale: slug, item: lamp, name: "Spam", phone: "5555555555" })).status === 429);
who = "a";
r = await call("GET", `/api/garage/sales/${sid}`);
const hold = r.json.holds.find(h => h.name === "Pat");
ok("seller sees the hold", !!hold && hold.phone === "973-555-0101");
ok("accept hold", (await call("PATCH", `/api/garage/holds/${hold.id}`, { status: "accepted" })).status === 200);
ok("item now held", db.raw.prepare("SELECT status FROM garage_sale_items WHERE item_id=?").get(crock).status === "held");

// ---------- Stripe Connect onboarding ----------
// A Bottle Tree storefront account id (the platform's own) must not count as a sales payout account.
db.raw.prepare("UPDATE users SET stripe_account_id='acct_PLATFORM' WHERE id=?").run(aId);
r = await call("GET", "/api/garage/stripe/status");
ok("Bottle Tree's stripe_account_id is ignored", r.status === 200 && r.json.connected === false);
r = await call("POST", "/api/garage/stripe/connect");
ok("Bottle Tree's account id left untouched", db.raw.prepare("SELECT stripe_account_id s FROM users WHERE id=?").get(aId).s === "acct_PLATFORM");
ok("connect returns onboarding link", r.status === 200 && r.json.url === "https://connect.stripe.test/onboard");
const acctCall = calls.find(c => c.url.endsWith("/v1/accounts"));
ok("seller account: full dashboard, seller pays Stripe fees, Stripe liable for losses, card payments",
   acctCall.form.get("controller[stripe_dashboard][type]") === "full" && acctCall.form.get("controller[fees][payer]") === "account" &&
   acctCall.form.get("controller[losses][payments]") === "stripe" && acctCall.form.get("capabilities[card_payments][requested]") === "true");
ok("second connect reuses the account", (await call("POST", "/api/garage/stripe/connect")).status === 200 && calls.filter(c => c.url.endsWith("/v1/accounts")).length === 1);
r = await call("GET", "/api/garage/stripe/status");
ok("not ready until onboarding done", r.json.connected && !r.json.ready);
acctReady = true;
r = await call("GET", "/api/garage/stripe/status");
ok("ready after onboarding", r.json.ready && db.raw.prepare("SELECT stripe_payouts_ready r FROM users WHERE id=?").get(aId).r === 1);
ok("online on", (await call("PATCH", `/api/garage/sales/${sid}`, { online_ok: true })).status === 200);

// ---------- checkout ----------
who = "anon";
r = await call("GET", `/sale/${slug}/item/${lamp}`);
ok("item page offers pickup and shipping", r.text.includes('value="pickup"') && r.text.includes('value="ship"') && r.text.includes("$12.50 shipping"));
ok("item page shows both prices when they differ", r.text.includes("At the sale: $40") && r.text.includes("Online: $52"));
r = await call("GET", `/sale/${slug}/item/${crock}`);
ok("held item offers no buying", !r.text.includes("Pay securely") && r.text.includes("On hold"));
r = await call("POST", "/api/public/garage/checkout", new URLSearchParams({ sale: slug, item: crock, fulfilment: "pickup" }));
ok("held item can't be bought", r.status === 409);
r = await call("POST", "/api/public/garage/checkout", new URLSearchParams({ sale: slug, item: cheap, fulfilment: "pickup" }));
ok("under $1 refused online", r.status === 400);
ok("mug price not reserved on refusal", db.raw.prepare("SELECT status FROM garage_sale_items WHERE item_id=?").get(cheap).status === "available");
r = await call("POST", "/api/public/garage/checkout", new URLSearchParams({ sale: slug, item: lamp, fulfilment: "ship" }));
ok("checkout redirects to Stripe", r.status === 303 && r.location === "https://checkout.stripe.test/pay");
const cs = calls.filter(c => c.url.endsWith("/v1/checkout/sessions")).pop().form;
const csCall = calls.filter(c => c.url.endsWith("/v1/checkout/sessions")).pop();
ok("direct charge: session created ON the seller's account", csCall.account === "acct_SELLER");
ok("no destination transfer (seller is the merchant)", !cs.get("payment_intent_data[transfer_data][destination]"));
ok("online price charged", cs.get("line_items[0][price_data][unit_amount]") === "5200");
ok("shipping charged", cs.get("shipping_options[0][shipping_rate_data][fixed_amount][amount]") === "1250");
ok("3% fee on item + shipping", cs.get("payment_intent_data[application_fee_amount]") === String(Math.round((5200 + 1250) * 0.03)));
ok("US address collected for shipping", cs.get("shipping_address_collection[allowed_countries][0]") === "US");
ok("item reserved", db.raw.prepare("SELECT status FROM garage_sale_items WHERE item_id=?").get(lamp).status === "pending");
ok("second buyer blocked while reserved", (await call("POST", "/api/public/garage/checkout", new URLSearchParams({ sale: slug, item: lamp, fulfilment: "pickup" }))).status === 409);
const order = db.raw.prepare("SELECT * FROM garage_orders WHERE item_id=? AND status='pending'").get(lamp);
ok("order recorded", order && order.total_cents === 6450 && order.fee_cents === 194 && order.fulfilment === "ship");
who = "a";
ok("seller can't mark a pending item sold", (await call("PATCH", `/api/garage/sales/${sid}/items/${lamp}`, { status: "sold" })).status === 409);

// ---------- webhook ----------
who = "anon";
ok("bad signature refused", (await call("POST", "/api/public/garage/stripe-webhook", "{}", { "stripe-signature": "t=1,v1=00" })).status === 400);
const done = { type: "checkout.session.completed", data: { object: { id: order.stripe_session_id, payment_status: "paid", payment_intent: "pi_1",
  customer_details: { name: "Remote Buyer", email: "rb@example.com", phone: "+15555550100" },
  collected_information: { shipping_details: { name: "Remote Buyer", address: { line1: "1 Main", city: "Austin", state: "TX", postal_code: "78701", country: "US" } } } } } };
ok("paid webhook", (await hook(done)).status === 200);
let o2 = db.raw.prepare("SELECT * FROM garage_orders WHERE id=?").get(order.id);
ok("order paid with buyer + address", o2.status === "paid" && o2.buyer_email === "rb@example.com" && JSON.parse(o2.ship_address).address.city === "Austin");
ok("item sold", db.raw.prepare("SELECT status FROM garage_sale_items WHERE item_id=?").get(lamp).status === "sold");
ok("replay is harmless", (await hook(done)).status === 200 && db.raw.prepare("SELECT status FROM garage_orders WHERE id=?").get(order.id).status === "paid");
who = "a";
ok("mark shipped with tracking", (await call("PATCH", `/api/garage/orders/${order.id}`, { status: "fulfilled", tracking: "1Z999" })).status === 200);

// expired checkout releases the item
who = "a"; await call("PATCH", `/api/garage/holds/${hold.id}`, { status: "done" });
ok("hold done frees the item", db.raw.prepare("SELECT status FROM garage_sale_items WHERE item_id=?").get(crock).status === "available");
who = "anon";
await call("POST", "/api/public/garage/checkout", new URLSearchParams({ sale: slug, item: crock, fulfilment: "pickup" }));
let o3 = db.raw.prepare("SELECT * FROM garage_orders WHERE item_id=? AND status='pending'").get(crock);
ok("pickup order has no shipping", o3 && o3.ship_cents === 0 && o3.total_cents === 13500);
await hook({ type: "checkout.session.expired", data: { object: { id: o3.stripe_session_id } } });
ok("expired releases the item", db.raw.prepare("SELECT status FROM garage_sale_items WHERE item_id=?").get(crock).status === "available");

// sold in person while buyer was paying -> refund_needed, via the Connect secret too
await call("POST", "/api/public/garage/checkout", new URLSearchParams({ sale: slug, item: crock, fulfilment: "pickup" }));
o3 = db.raw.prepare("SELECT * FROM garage_orders WHERE item_id=? AND status='pending'").get(crock);
db.raw.prepare("UPDATE garage_sale_items SET status='sold' WHERE item_id=?").run(crock);
await hook({ type: "checkout.session.completed", data: { object: { id: o3.stripe_session_id, payment_status: "paid", customer_details: {} } } }, "whsec_connect");
ok("clash flagged for refund", db.raw.prepare("SELECT status FROM garage_orders WHERE id=?").get(o3.id).status === "refund_needed");
who = "a";
ok("refund_needed can't be marked done", (await call("PATCH", `/api/garage/orders/${o3.id}`, { status: "fulfilled" })).status === 409);

// stale pending is released on read even if Stripe never calls back
db.raw.prepare("UPDATE garage_sale_items SET status='available' WHERE item_id=?").run(crock);
who = "anon"; await call("POST", "/api/public/garage/checkout", new URLSearchParams({ sale: slug, item: crock, fulfilment: "pickup" }));
db.raw.prepare("UPDATE garage_orders SET created_at=? WHERE item_id=? AND status='pending'").run(new Date(Date.now() - 40 * 60000).toISOString(), crock);
await call("GET", `/sale/${slug}`);
ok("stale reservation released", db.raw.prepare("SELECT status FROM garage_sale_items WHERE item_id=?").get(crock).status === "available");

// account.updated keeps readiness in sync
await hook({ type: "account.updated", data: { object: { id: "acct_SELLER", details_submitted: true, charges_enabled: false, capabilities: { card_payments: "inactive" } } } }, "whsec_connect");
ok("account.updated can switch payouts off", db.raw.prepare("SELECT stripe_payouts_ready r FROM users WHERE id=?").get(aId).r === 0);
r = await call("GET", `/sale/${slug}`);
ok("buy button gone when payouts are off", !r.text.includes("Buy online"));

// ---------- delete rules ----------
who = "a";
ok("sale with orders can't be deleted", (await call("DELETE", `/api/garage/sales/${sid}`)).status === 409);
r = await call("POST", "/api/garage/sales", { title: "Scratch", city: "Newark", state: "NJ", starts_on: today });
ok("empty sale deletes", (await call("DELETE", `/api/garage/sales/${r.json.id}`)).status === 200);
r = await call("GET", "/api/garage/sales");
ok("sale list", r.status === 200 && r.json.length === 1 && r.json[0].url === `https://g.test/sale/${slug}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Run:  node worker/tests/labels_test.mjs
// Shipping labels through the REAL worker routes, with Shippo and eBay stubbed at fetch(). Proves
// who may buy, what we send Shippo, the price check, one-label-per-order, and that buying marks
// the order shipped - NOT that Shippo/USPS accept this label; that needs one real purchase.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as L from "../labels.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

// ---------- pure ----------
ok("labelsOn: listed email + token", L.labelsOn({ SHIPPO_API_TOKEN: "t", LABEL_USERS: "a@x.com, DJ@Soltis.info" }, "dj@soltis.info"));
ok("labelsOn: not listed / no token", !L.labelsOn({ SHIPPO_API_TOKEN: "t", LABEL_USERS: "a@x.com" }, "b@x.com") && !L.labelsOn({ LABEL_USERS: "b@x.com" }, "b@x.com"));
ok("cleanFrom ok", L.cleanFrom({ name: "Derek", street1: "1 Main St", city: "Kenilworth", state: "nj", zip: "07033-1234", phone: "(908) 555-0100" }).value?.zip === "07033");
ok("cleanFrom refuses bad state / missing street", L.cleanFrom({ name: "D", street1: "1 Main", city: "K", state: "ZZ", zip: "07033" }).error && L.cleanFrom({ name: "D", city: "K", state: "NJ", zip: "07033" }).error);
ok("toAddress from stored buyer JSON", JSON.stringify(L.toAddress('{"name":"Bob","phone":"512","address":{"line1":"1 Congress Ave","city":"Austin","state":"TX","postal_code":"78701","country":"US"}}'))
   === JSON.stringify({ name: "Bob", street1: "1 Congress Ave", street2: "", city: "Austin", state: "TX", zip: "78701", country: "US", phone: "512" }));
ok("toAddress: incomplete -> null", L.toAddress('{"phone":"5"}') === null && L.toAddress(null) === null);
ok("parcelFor: estimate, or the seller's own numbers", L.parcelFor({ box_in: [10, 5, 5], packed_weight_lb: 0.4 }).weight === "0.4" &&
   L.parcelFor({ box_in: [10, 5, 5], packed_weight_lb: 0.4 }, { box_in: [12, 9, 4], weight_lb: 1.25 }).length === "12");
ok("parcelFor: nothing usable -> null", L.parcelFor(null) === null && L.parcelFor({ box_in: [10, 5, 5], packed_weight_lb: 0 }) === null);
ok("carrierOf", L.carrierOf("USPS") === "USPS" && L.carrierOf("FedEx") === "FedEx" && L.carrierOf("DHL Express") === null);

// ---------- Shippo + eBay + Stripe, stubbed ----------
const calls = [];
const RATE = "a".repeat(32), RATE2 = "b".repeat(32);
let rateAmount = "7.45";
const jr = (o, status = 200) => new Response(o === null ? null : JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (u, init = {}) => {
  const url = String(u), method = init.method || "GET";
  const body = typeof init.body === "string" ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })() : init.body || null;
  calls.push({ url, method, body, auth: init.headers && (init.headers.authorization || init.headers.Authorization) });
  if (url === "https://api.goshippo.com/shipments/") return jr({ rates: [
    { object_id: RATE, provider: "USPS", servicelevel: { token: "usps_ground_advantage", name: "Ground Advantage" }, amount: "7.45", currency: "USD", estimated_days: 4 },
    { object_id: RATE2, provider: "USPS", servicelevel: { token: "usps_priority", name: "Priority Mail" }, amount: "11.20", currency: "USD", estimated_days: 2 },
    { object_id: "c".repeat(32), provider: "UPS", servicelevel: { token: "ups_next_day_air", name: "Next Day Air" }, amount: "60.00", currency: "USD" }] });
  if (url.startsWith("https://api.goshippo.com/rates/")) return jr({ object_id: url.split("/").pop(), provider: "USPS", servicelevel: { name: "Ground Advantage" }, amount: rateAmount, currency: "USD" });
  if (url === "https://api.goshippo.com/transactions/") return jr({ object_id: "tx" + calls.length, status: "SUCCESS", tracking_number: "9400111899223456789012", label_url: "https://deliver.goshippo.com/x.pdf" });
  if (url.endsWith("/v1/checkout/sessions")) return jr({ id: "cs_" + calls.length, url: "https://checkout.stripe.test/pay" });
  if (url.includes("/v1/accounts/acct_S")) return jr({ id: "acct_S", details_submitted: true, charges_enabled: true, capabilities: { card_payments: "active", transfers: "active" } });
  return jr({ error: "unstubbed " + url }, 404);
};

const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const mails = [], pending = [];
const env = {
  DB: db, ASSETS: { fetch: async () => new Response("asset") },
  PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", SHIPPO_API_TOKEN: "shippo_test_x", LABEL_USERS: "d@example.com",
  EMAIL: { send: async m => { mails.push(m); return { messageId: "m" } } },
};
const jar = { d: "", x: "" }; let who = "d";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie: jar[who] },
    body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil(p) { pending.push(p); } });
  const sc = r.headers.get("set-cookie"); if (sc) jar[who] = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json };
};
const settle = async () => { while (pending.length) await pending.shift(); };

await call("POST", "/api/auth/register", { email: "d@example.com", password: "password123" });
who = "x"; await call("POST", "/api/auth/register", { email: "x@example.com", password: "password123" }); who = "d";
const me = db.raw.prepare("SELECT id FROM users WHERE email='d@example.com'").get().id;
const item = (await call("POST", "/api/items", { name: "RAM", description: "32gb" })).json.id;
db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)").run(crypto.randomUUID(), item,
  JSON.stringify({ shipping: { box_in: [10, 5, 5], packed_weight_lb: 0.4 } }), new Date().toISOString());
// a paid garage ship order and an open eBay order for the same seller
const saleId = crypto.randomUUID(), t0 = new Date().toISOString();
db.raw.prepare("INSERT INTO garage_sales (id,user_id,slug,title,kind,city,state,starts_on,ends_on,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(saleId, me, "elm-st-1", "Elm St", "garage", "Montclair", "NJ", "2026-10-10", "2026-10-10", "published", t0, t0);
const addr = JSON.stringify({ name: "Rae Buyer", address: { line1: "5 Oak St", city: "Austin", state: "TX", postal_code: "78701", country: "US" } });
db.raw.prepare("INSERT INTO garage_orders (id,sale_id,item_id,seller_account,fulfilment,item_cents,ship_cents,fee_cents,total_cents,buyer_email,ship_address,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("go1", saleId, item, "acct_S", "ship", 5000, 800, 174, 5800, "rae@example.com", addr, "paid", t0, t0);

// ---------- routes ----------
who = "x";
let r = await call("GET", "/api/labels/settings");
ok("not on for other accounts", r.json.enabled === false);
ok("other accounts can't get rates or buy", (await call("POST", "/api/labels/rates", { kind: "garage", order_id: "go1" })).status === 403 &&
   (await call("POST", "/api/labels/buy", { kind: "garage", order_id: "go1", rate_id: RATE, amount_cents: 745 })).status === 403);
who = "d";
ok("on for the listed account", (await call("GET", "/api/labels/settings")).json.enabled === true);
r = await call("POST", "/api/labels/rates", { kind: "garage", order_id: "go1" });
ok("rates need a return address first", r.status === 409 && r.json.needs_from);
ok("bad address refused", (await call("PUT", "/api/labels/settings", { name: "Derek", street1: "1 Main", city: "Kenilworth", state: "XX", zip: "07033" })).status === 400);
ok("save return address", (await call("PUT", "/api/labels/settings", { name: "Derek", street1: "1 Main St", city: "Kenilworth", state: "NJ", zip: "07033" })).status === 200);
r = await call("POST", "/api/labels/rates", { kind: "garage", order_id: "go1" });
const sh = calls.filter(c => c.url.endsWith("/shipments/")).pop();
ok("rates: cheapest first, air dropped, rate ids kept", r.status === 200 && r.json.rates.map(x => x.token).join() === "usps_ground_advantage,usps_priority" && r.json.rates[0].rate_id === RATE, r.json);
ok("shipment uses full from/to and the estimated box", sh.body.address_from.street1 === "1 Main St" && sh.body.address_to.street1 === "5 Oak St" && sh.body.parcels[0].length === "10" && sh.auth === "ShippoToken shippo_test_x");
r = await call("POST", "/api/labels/rates", { kind: "garage", order_id: "go1", box_in: [12, 9, 4], weight_lb: 1.3 });
ok("seller's own box and weight override the estimate", calls.filter(c => c.url.endsWith("/shipments/")).pop().body.parcels[0].weight === "1.3");

rateAmount = "8.10";
r = await call("POST", "/api/labels/buy", { kind: "garage", order_id: "go1", rate_id: RATE, amount_cents: 745 });
ok("price changed -> nothing bought", r.status === 409 && !calls.some(c => c.url.endsWith("/transactions/")));
rateAmount = "7.45";
r = await call("POST", "/api/labels/buy", { kind: "garage", order_id: "go1", rate_id: RATE, amount_cents: 745, file_type: "PDF" });
await settle();
const tx = calls.find(c => c.url.endsWith("/transactions/"));
ok("label bought for that rate, letter paper", r.status === 200 && tx.body.rate === RATE && tx.body.label_file_type === "PDF" && r.json.label.label_url.endsWith(".pdf"), r.json);
const go = db.raw.prepare("SELECT * FROM garage_orders WHERE id='go1'").get();
ok("garage order marked shipped with the label's tracking", go.status === "fulfilled" && go.tracking === "9400111899223456789012");
ok("buyer emailed the tracking", mails.some(m => m.to === "rae@example.com" && m.text.includes("9400111899223456789012")));
ok("second label for the same order refused", (await call("POST", "/api/labels/buy", { kind: "garage", order_id: "go1", rate_id: RATE, amount_cents: 745 })).status === 409 &&
   calls.filter(c => c.url.endsWith("/transactions/")).length === 1);
r = await call("GET", "/api/labels/for?kind=garage&order=go1");
ok("label kept for reprinting", r.json.label && r.json.label.amount_cents === 745 && r.json.label.carrier === "USPS");
who = "x"; ok("someone else's label is not visible", (await call("GET", "/api/labels/for?kind=garage&order=go1")).json?.label == null || (await call("GET", "/api/labels/for?kind=garage&order=go1")).status === 403); who = "d";
ok("bad rate id refused before calling Shippo", (await (async () => {
  db.raw.prepare("INSERT INTO garage_orders (id,sale_id,item_id,seller_account,fulfilment,item_cents,ship_cents,fee_cents,total_cents,ship_address,status,created_at,updated_at) VALUES ('go2',?,?,?,?,1,0,0,1,?,'paid',?,?)").run(saleId, item, "acct_S", "ship", addr, t0, t0);
  return (await call("POST", "/api/labels/buy", { kind: "garage", order_id: "go2", rate_id: "../../x", amount_cents: 1 })).status; })()) === 400);
ok("pickup orders have no label", (await (async () => {
  db.raw.prepare("INSERT INTO garage_orders (id,sale_id,item_id,seller_account,fulfilment,item_cents,ship_cents,fee_cents,total_cents,status,created_at,updated_at) VALUES ('go3',?,?,?,'pickup',1,0,0,1,'paid',?,?)").run(saleId, item, "acct_S", t0, t0);
  return (await call("POST", "/api/labels/rates", { kind: "garage", order_id: "go3" })).status; })()) === 409);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

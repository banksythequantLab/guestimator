// Run:  node worker/tests/ebayorders_test.mjs
// eBay sale alerts through the REAL worker routes and the scheduled() handler, against the
// node:sqlite D1 shim. eBay is stubbed at fetch(): this proves how we read orders and what we do
// with them, NOT that eBay returns exactly this shape - that needs one real sale.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as O from "../ebayorders.js";
import { skuFor } from "../ebay.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

// ---------- pure ----------
const rawOrder = (id, sku, extra = {}, legacy = "198678618562") => ({
  orderId: id, creationDate: "2026-09-30T15:00:00.000Z", orderFulfillmentStatus: "NOT_STARTED", orderPaymentStatus: "PAID",
  cancelStatus: { cancelState: "NONE_REQUESTED" }, buyer: { username: "buyer_bob" }, pricingSummary: { total: { value: "206.50", currency: "USD" } },
  fulfillmentStartInstructions: [{ shippingStep: { shippingServiceCode: "USPSParcel", shipTo: { fullName: "Bob Buyer", primaryPhone: { phoneNumber: "5125550100" },
    contactAddress: { addressLine1: "1 Congress Ave", city: "Austin", stateOrProvince: "TX", postalCode: "78701", countryCode: "US" } } } }],
  lineItems: [{ lineItemId: "L1", sku, legacyItemId: legacy, title: "Cisco 32GB", quantity: 1, lineItemFulfillmentInstructions: { shipByDate: "2026-10-02T00:00:00.000Z" } }],
  ...extra });
let p = O.parseOrder(rawOrder("12-1", "GUESS-x"));
ok("parse: total, buyer, ship-to in slip shape", p.totalCents === 20650 && p.buyer === "buyer_bob" && p.shipTo.address.city === "Austin" && p.shipTo.name === "Bob Buyer" && p.shipTo.phone === "5125550100", p);
ok("parse: line + ship-by", p.lines[0].lineItemId === "L1" && p.lines[0].shipBy.startsWith("2026-10-02") && p.status === "NOT_STARTED");
ok("parse: cancelled", O.parseOrder(rawOrder("12-2", "x", { cancelStatus: { cancelState: "CANCELED" } })).status === "CANCELLED");
ok("parse: unpaid flagged", O.parseOrder(rawOrder("12-3", "x", { orderPaymentStatus: "PENDING" })).paid === false);
ok("filter shape", O.sinceFilter("2026-09-30T10:00:00Z") === "lastmodifieddate:[2026-09-30T10:00:00.000Z..]");
const nowMs = Date.parse("2026-09-30T12:00:00Z");
ok("since: first read goes back a day before connecting", O.syncSince({ created_at: "2026-09-29T12:00:00Z" }, nowMs) === "2026-09-28T12:00:00.000Z");
ok("since: overlaps the last read by an hour", O.syncSince({ created_at: "2026-01-01T00:00:00Z", orders_synced_at: "2026-09-30T11:45:00Z" }, nowMs) === "2026-09-30T10:45:00.000Z");
ok("since: never more than 30 days", O.syncSince({ created_at: "2025-01-01T00:00:00Z" }, nowMs) === "2026-08-31T12:00:00.000Z");
ok("carrier by shape", O.carrierFor("9400 1118 9922 3456 7890 12") === "USPS" && O.carrierFor("1Z999AA10123456784") === "UPS" && O.carrierFor("123456789012") === "FedEx" && O.carrierFor("ABC") === null);

// ---------- eBay, stubbed ----------
const calls = [];
let orders = [], scopeDenied = false;
const jr = (o, status = 200) => new Response(o === null ? null : JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (u, init = {}) => {
  const url = String(u), method = init.method || "GET";
  const body = typeof init.body === "string" ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })() : null;
  calls.push({ url, method, body });
  if (url.endsWith("/identity/v1/oauth2/token")) {
    const f = new URLSearchParams(init.body);
    calls[calls.length - 1].form = Object.fromEntries(f);
    if (f.get("grant_type") === "authorization_code") return jr({ access_token: "UACC", refresh_token: "UREF", expires_in: 7200, refresh_token_expires_in: 47304000 });
    return jr({ access_token: "UACC2", expires_in: 7200 });
  }
  if (url.includes("/commerce/identity/v1/user/")) return jr({ userId: "EU1", username: "derek_sells" });
  if (url.includes("/sell/fulfillment/v1/order?")) return scopeDenied
    ? jr({ errors: [{ errorId: 1100, message: "Access denied", longMessage: "Insufficient permissions to fulfill the request." }] }, 403)
    : jr({ orders, total: orders.length });
  if (/\/sell\/fulfillment\/v1\/order\/[^/]+\/shipping_fulfillment$/.test(url) && method === "POST") return jr(null, 201);
  return jr({ errors: [{ message: "unstubbed " + url }] }, 404);
};

const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const mails = [];
const env = {
  DB: db, ASSETS: { fetch: async () => new Response("asset") },
  PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test",
  EBAY_CLIENT_ID: "cid", EBAY_CLIENT_SECRET: "csec", EBAY_RUNAME: "R", EBAY_TOKEN_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64"),
  EMAIL: { send: async m => { mails.push(m); return { messageId: "m" + mails.length }; } },
};
let cookie = "";
const pending = [];
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, {
    method, redirect: "manual", headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil(x) { pending.push(x); } });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
};
const settle = async () => { while (pending.length) await pending.shift(); };

ok("register", (await call("POST", "/api/auth/register", { email: "d@example.com", password: "password123" })).status === 200);
const me = db.raw.prepare("SELECT id FROM users WHERE email='d@example.com'").get().id;
const item = (await call("POST", "/api/items", { name: "Cisco RAM", description: "32gb ddr4" })).json.id;
const other = (await call("POST", "/api/items", { name: "Unlisted", description: "x" })).json.id;
db.raw.prepare("INSERT INTO ebay_listings (id,item_id,user_id,sku,status,listing_id,created_at,updated_at) VALUES (?,?,?,?,'published','198678618562',?,?)")
  .run(crypto.randomUUID(), item, me, skuFor(item), new Date().toISOString(), new Date().toISOString());

// same item also on a garage sale page, still available
const sale = (await call("POST", "/api/garage/sales", { title: "Elm St", city: "Montclair", state: "NJ", starts_on: "2026-10-10" })).json.id;
db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)").run(crypto.randomUUID(), item,
  JSON.stringify({ price_range: { suggested_retail: 199 }, shipping: { box_in: [10, 5, 5], packed_weight_lb: 0.4 } }), new Date().toISOString());
ok("item on the sale page", (await call("POST", `/api/garage/sales/${sale}/items`, { item_id: item })).status === 200);

// not connected -> nothing to read
let r = await call("GET", "/api/ebay/orders");
ok("no eBay: empty list, not connected", r.status === 200 && r.json.connected === false && r.json.orders.length === 0);

// connect (web callback)
const st = new URL((await call("POST", "/api/ebay/connect", {})).json.url).searchParams.get("state");
const cons = calls.length;
const saved = cookie; cookie = "";
await call("GET", `/api/ebay/callback?code=C&state=${st}`); cookie = saved;
ok("consent asks for sell.fulfillment", (await call("POST", "/api/ebay/connect", {})).json.url.includes("sell.fulfillment"));

// an older connection whose consent lacks fulfillment
scopeDenied = true;
db.raw.prepare("UPDATE ebay_accounts SET access_expires_at=? WHERE user_id=?").run(new Date(Date.now() - 1000).toISOString(), me);
r = await call("GET", "/api/ebay/orders");
const refresh = calls.slice(cons).find(c => c.form && c.form.grant_type === "refresh_token");
ok("token refresh sends no scope (works for old consents)", refresh && !("scope" in refresh.form), refresh && refresh.form);
ok("scope refusal -> needs_reconnect, remembered", r.json.needs_reconnect === true && db.raw.prepare("SELECT fulfillment_ok f FROM ebay_accounts WHERE user_id=?").get(me).f === 0);
const before = calls.length;
r = await call("GET", "/api/ebay/orders");
ok("does not keep hammering eBay while reconnect is needed", r.json.needs_reconnect === true && calls.slice(before).every(c => !c.url.includes("/fulfillment/")));

// reconnect clears the flag; a sale comes in
cookie = ""; const st2 = new URL((await (async () => { cookie = saved; const x = await call("POST", "/api/ebay/connect", {}); cookie = ""; return x; })()).json.url).searchParams.get("state");
await call("GET", `/api/ebay/callback?code=C2&state=${st2}`); cookie = saved;
ok("reconnect resets fulfillment_ok", db.raw.prepare("SELECT fulfillment_ok f FROM ebay_accounts WHERE user_id=?").get(me).f === null);
scopeDenied = false;
orders = [rawOrder("12-100", skuFor(item)), rawOrder("12-200", "SOMEONE-ELSES-SKU", {}, "555000111"), rawOrder("12-300", skuFor(item), { orderPaymentStatus: "PENDING" }),
          rawOrder("12-250", "", {}, "198678618562")];
r = await call("GET", "/api/ebay/orders");
await settle();
ok("our sales recorded (by SKU, and by listing id when the SKU is missing); foreign and unpaid ignored",
   r.json.orders.map(o => o.order_id).sort().join() === "12-100,12-250" && r.json.orders.every(o => o.status === "NOT_STARTED"), r.json.orders.map(o => o.order_id));
const o100 = r.json.orders.find(o => o.order_id === "12-100");
ok("ship-to comes through for the slip", /Austin/.test(o100.ship_to) && o100.item_title === "Cisco RAM");
ok("item marked sold", db.raw.prepare("SELECT listing_status s FROM items WHERE id=?").get(item).s === "sold");
ok("garage-sale copy marked sold (no double sale)", db.raw.prepare("SELECT status s FROM garage_sale_items WHERE item_id=?").get(item).s === "sold");
ok("seller emailed per sale", mails.filter(m => /Sold on eBay/.test(m.subject)).length === 2 && mails[0].to === "d@example.com" && mails[0].text.includes("Austin"), mails.map(m => m.subject));
mails.length = 0;
const rowId = o100.id;

// re-read: no duplicate row, no second email
db.raw.prepare("UPDATE ebay_accounts SET orders_synced_at=? WHERE user_id=?").run(new Date(Date.now() - 600e3).toISOString(), me);
r = await call("GET", "/api/ebay/orders"); await settle();
ok("re-read is idempotent", r.json.orders.length === 2 && mails.length === 0);
{ const n = calls.length; await call("GET", "/api/ebay/orders");
  ok("recent read is not repeated within 2 minutes", calls.slice(n).every(c => !c.url.includes("/fulfillment/"))); }

// packing slip
let s = await call("GET", `/api/ebay/orders/${encodeURIComponent(rowId)}/slip`);
ok("eBay packing slip: ship-to, order number, eBay note, private", s.status === 200 && s.text.includes("Bob Buyer") && s.text.includes("12-100") && s.text.includes("Sold on eBay") && s.text.includes("$206.50") && /no-store/.test(s.headers.get("cache-control")));

// mark shipped
ok("unknown tracking shape needs a carrier", (await call("POST", `/api/ebay/orders/${encodeURIComponent(rowId)}/ship`, { tracking: "ABC123" })).status === 400);
r = await call("POST", `/api/ebay/orders/${encodeURIComponent(rowId)}/ship`, { tracking: "9400 1118 9922 3456 7890 12" });
const sf = calls.find(c => c.url.endsWith("/order/12-100/shipping_fulfillment"));
ok("mark shipped posts line, carrier and tracking to eBay", r.status === 200 && sf && sf.body.lineItems[0].lineItemId === "L1" && sf.body.shippingCarrierCode === "USPS" && sf.body.trackingNumber === "9400111899223456789012", sf && sf.body);
const row = db.raw.prepare("SELECT * FROM ebay_orders WHERE id=?").get(rowId);
ok("row fulfilled, address dropped once shipped", row.status === "FULFILLED" && row.ship_to === null && row.tracking === "9400111899223456789012");

// scheduled(): another seller's sale noticed without the app open
orders = [rawOrder("12-400", skuFor(item), { lineItems: [{ lineItemId: "L9", sku: skuFor(item), title: "Cisco 32GB", quantity: 1 }] })];
db.raw.prepare("UPDATE ebay_accounts SET orders_synced_at=? WHERE user_id=?").run(new Date(Date.now() - 20 * 60e3).toISOString(), me);
await worker.scheduled({}, env, { waitUntil() {} });
ok("cron picks up a new sale and emails", db.raw.prepare("SELECT COUNT(*) n FROM ebay_orders WHERE order_id='12-400'").get().n === 1 && mails.length === 1, mails.map(m => m.subject));
const n0 = calls.length;
await worker.scheduled({}, env, { waitUntil() {} });
ok("cron skips accounts read in the last 10 minutes", calls.slice(n0).length === 0);

// someone else can't see or ship it
const mine = cookie; cookie = "";
await call("POST", "/api/auth/register", { email: "x@example.com", password: "password123" });
ok("other user: 404 on slip and ship", (await call("GET", `/api/ebay/orders/${encodeURIComponent(rowId)}/slip`)).status === 404 &&
   (await call("POST", `/api/ebay/orders/${encodeURIComponent(rowId)}/ship`, {})).status === 404);
cookie = mine;
ok("unrelated item untouched", db.raw.prepare("SELECT listing_status s FROM items WHERE id=?").get(other).s !== "sold");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

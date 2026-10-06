// Run:  node worker/tests/bestoffer_test.mjs
// Best Offer through the REAL routes, eBay stubbed at fetch(). Proves the thresholds, the offer
// update eBay is sent (built from eBay's own copy of the offer), that a price drop moves the
// auto-accept with it, and what is stored - NOT that eBay accepts these terms on a real listing.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bestOfferTerms, ebayBestOffer } from "../ebay.js";
import { seal } from "../ebay.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

// ---------- pure ----------
let t = bestOfferTerms(199, 110);
ok("$199, floor $110: accept $179+, decline under $139 (70%)", t.accept_cents === 17900 && t.decline_cents === 13900, t);
t = bestOfferTerms(199, 160);
ok("a floor above 70% sets the decline line", t.accept_cents === 17900 && t.decline_cents === 16000, t);
t = bestOfferTerms(100, 95);
ok("floor above 90%: never auto-accept below the floor", t.accept_cents === 9500 && t.decline_cents === 9400, t);
t = bestOfferTerms(100, 120);
ok("floor at or above the price: accept just under it", t.accept_cents === 9900 && t.decline_cents < 9900, t);
t = bestOfferTerms(199, 145, 11500);
ok("seller minimum replaces the 70%/floor decline line", t.accept_cents === 17900 && t.decline_cents === 11500, t);
ok("under $10: no offers", bestOfferTerms(9.99, 0) === null);
t = bestOfferTerms(15, 0);
ok("50c steps under $20", t.accept_cents === 1350 && t.decline_cents === 1050, t);
ok("eBay shape", JSON.stringify(ebayBestOffer({ accept_cents: 17900, decline_cents: 13900 })) ===
  JSON.stringify({ bestOfferEnabled: true, autoAcceptPrice: { value: "179.00", currency: "USD" }, autoDeclinePrice: { value: "139.00", currency: "USD" } }));
ok("off", ebayBestOffer(null).bestOfferEnabled === false);

// ---------- eBay, stubbed ----------
const calls = []; let failPut = false; let made30 = false;
const offer = { offerId: "OFF-1", sku: "S", marketplaceId: "EBAY_US", format: "FIXED_PRICE", status: "PUBLISHED", listing: { listingId: "L1" },
  categoryId: "170083", availableQuantity: 1, listingDescription: "d", merchantLocationKey: "loc",
  listingPolicies: { fulfillmentPolicyId: "F", paymentPolicyId: "P", returnPolicyId: "R" }, pricingSummary: { price: { value: "199.00", currency: "USD" } } };
const jr = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (u, init = {}) => {
  const url = String(u); const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ url, method: init.method || "GET", body });
  if (url.endsWith("/sell/inventory/v1/offer/OFF-1") && (init.method || "GET") === "GET") return jr(offer);
  if (url.endsWith("/sell/inventory/v1/offer/OFF-1") && init.method === "PUT")
    return failPut ? jr({ errors: [{ errorId: 25001, longMessage: "Best Offer is not available in this category." }] }, 400) : new Response(null, { status: 204 });
  if (url.endsWith("/bulk_update_price_quantity")) return jr({ responses: [{ statusCode: 200 }] });
  if (/\/sell\/account\/v1\/return_policy\?/.test(url)) return jr({ returnPolicies: [{ returnPolicyId: "RNONE", name: "No returns", returnsAccepted: false },
    ...(made30 ? [{ returnPolicyId: "R30", name: "Guestimator 30-day returns", returnsAccepted: true, returnPeriod: { value: 30, unit: "DAY" }, returnShippingCostPayer: "BUYER" }] : [])] });
  if (/\/sell\/account\/v1\/(fulfillment|payment)_policy\?/.test(url)) return jr({ fulfillmentPolicies: [], paymentPolicies: [] });
  if (url.endsWith("/sell/account/v1/return_policy") && init.method === "POST") { made30 = true; return jr({ returnPolicyId: "R30" }, 201); }
  return jr({ errors: [{ message: "unstubbed " + url }] }, 404);
};

const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, ASSETS: { fetch: async () => new Response("a") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", EBAY_CLIENT_ID: "c", EBAY_CLIENT_SECRET: "s", EBAY_RUNAME: "R",
  EBAY_TOKEN_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 3)).toString("base64") };
let cookie = "";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const tx = await r.text(); let json = null; try { json = JSON.parse(tx); } catch {}
  return { status: r.status, json };
};
await call("POST", "/api/auth/register", { email: "d@example.com", password: "password123" });
const me = db.raw.prepare("SELECT id FROM users WHERE email='d@example.com'").get().id;
const t0 = new Date().toISOString();
db.raw.prepare("INSERT INTO ebay_accounts (user_id,ebay_user_id,ebay_username,refresh_token_enc,access_token_enc,access_expires_at,orders_synced_at,fulfillment_ok,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)")
  .run(me, "EU1", "d", await seal(env, "REF"), await seal(env, "ACC"), new Date(Date.now() + 3600e3).toISOString(), t0, t0, t0);
const id = (await call("POST", "/api/items", { name: "Cisco 32GB", description: "Cisco 32GB" })).json.id;
db.raw.prepare("UPDATE items SET listing_status='live', price_cents=19900 WHERE id=?").run(id);
db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)").run(crypto.randomUUID(), id, JSON.stringify({ price_range: { low: 120, floor: 110 } }), t0);
const lid = crypto.randomUUID();
db.raw.prepare("INSERT INTO ebay_listings (id,item_id,user_id,sku,status,offer_id,listing_id,listing_url,price_cents,created_at,updated_at) VALUES (?,?,?,?,'published','OFF-1','L1','https://www.ebay.com/itm/1',19900,?,?)")
  .run(lid, id, me, "S", t0, t0);
const row = () => db.raw.prepare("SELECT price_cents p, best_offer_accept_cents a, best_offer_decline_cents d FROM ebay_listings WHERE id=?").get(lid);

let r = await call("POST", `/api/ebay/listings/${lid}/best-offer`, { enabled: true });
let put = calls.filter(c => c.method === "PUT").pop();
ok("turn on: thresholds returned", r.status === 200 && r.json.best_offer.accept_cents === 17900 && r.json.best_offer.decline_cents === 13900, r.json);
ok("offer update built from eBay's copy, read-only fields dropped", put && put.body.categoryId === "170083" && put.body.listingPolicies.fulfillmentPolicyId === "F"
  && !("offerId" in put.body) && !("status" in put.body) && !("listing" in put.body), put && put.body);
ok("terms sent to eBay", put.body.listingPolicies.bestOfferTerms.bestOfferEnabled === true && put.body.listingPolicies.bestOfferTerms.autoAcceptPrice.value === "179.00");
ok("terms stored", row().a === 17900 && row().d === 13900, row());

r = await call("POST", `/api/ebay/slow/${lid}/lower`, { price_cents: 15900 });
put = calls.filter(c => c.method === "PUT").pop();
ok("price drop with offers on goes through one offer update", r.status === 200 && put.body.pricingSummary.price.value === "159.00"
  && put.body.listingPolicies.bestOfferTerms.autoAcceptPrice.value === "143.00" && !calls.some(c => c.url.endsWith("bulk_update_price_quantity")), put.body);
ok("new price and thresholds stored", row().p === 15900 && row().a === 14300 && row().d === 11100, row());

const pc = await call("GET", "/api/ebay/pricecheck");
ok("price check shows the offer settings", pc.json.listings[0].best_offer.accept_cents === 14300, pc.json.listings[0]);

failPut = true;
r = await call("POST", `/api/ebay/listings/${lid}/best-offer`, { enabled: false });
ok("eBay's refusal comes through, nothing changed here", r.status === 502 && /not available/.test(r.json.error) && row().a === 14300, r.json);
failPut = false;
r = await call("POST", `/api/ebay/listings/${lid}/best-offer`, { enabled: false });
put = calls.filter(c => c.method === "PUT").pop();
ok("turn off", r.status === 200 && put.body.listingPolicies.bestOfferTerms.bestOfferEnabled === false && row().a === null, row());
r = await call("POST", `/api/ebay/slow/${lid}/lower`, { price_cents: 14900 });
ok("offers off: price drop uses the plain price update", r.status === 200 && calls.some(c => c.url.endsWith("bulk_update_price_quantity")));
ok("someone else's listing -> 404", (await call("POST", `/api/ebay/listings/nope/best-offer`, { enabled: true })).status === 404);

// ---------- seller's own minimum ----------
r = await call("POST", `/api/ebay/listings/${lid}/best-offer`, { enabled: true, min_cents: 11500 });
ok("minimum set: offers from $115 reach the seller", r.status === 200 && r.json.best_offer.decline_cents === 11500
  && calls.filter(c => c.method === "PUT").pop().body.listingPolicies.bestOfferTerms.autoDeclinePrice.value === "115.00", r.json);
ok("a minimum at or above the price is refused", (await call("POST", `/api/ebay/listings/${lid}/best-offer`, { enabled: true, min_cents: 99900 })).status === 400);
ok("price check shows the minimum", (await call("GET", "/api/ebay/pricecheck")).json.listings[0].best_offer.min_cents === 11500);
r = await call("POST", `/api/ebay/slow/${lid}/lower`, { price_cents: 13900 });
ok("minimum survives a price drop", r.status === 200 && db.raw.prepare("SELECT best_offer_decline_cents d, best_offer_min_cents m FROM ebay_listings WHERE id=?").get(lid).d === 11500, db.raw.prepare("SELECT * FROM ebay_listings WHERE id=?").get(lid));
r = await call("POST", `/api/ebay/listings/${lid}/best-offer`, { enabled: true, min_cents: null });
ok("blank minimum goes back to automatic", r.status === 200 && db.raw.prepare("SELECT best_offer_min_cents m FROM ebay_listings WHERE id=?").get(lid).m === null && r.json.best_offer.decline_cents !== 11500, r.json);

// ---------- return policy on a live listing ----------
r = await call("POST", `/api/ebay/listings/${lid}/returns`, { policy_id: "new30" });
put = calls.filter(c => c.method === "PUT").pop();
ok("switch to 30-day returns: policy created once, offer re-pointed, rest kept", r.status === 200 && r.json.returns === "30-day returns, buyer pays return shipping"
  && put.body.listingPolicies.returnPolicyId === "R30" && put.body.listingPolicies.fulfillmentPolicyId === "F", r.json);
r = await call("POST", `/api/ebay/listings/${lid}/returns`, { policy_id: "someone-elses" });
ok("a policy that isn't the seller's is refused", r.status === 400);
r = await call("POST", `/api/ebay/listings/${lid}/returns`, { policy_id: "RNONE" });
ok("back to an existing policy", r.status === 200 && r.json.returns === "No returns" && calls.filter(c => c.method === "PUT").pop().body.listingPolicies.returnPolicyId === "RNONE", r.json);
// ---------- change price from the item page (2026-10-05): up or down ----------
db.raw.prepare("UPDATE ebay_listings SET best_offer_min_cents=NULL WHERE id=?").run(lid);
r = await call("POST", `/api/ebay/listings/${lid}/best-offer`, { enabled: true });
r = await call("POST", `/api/ebay/listings/${lid}/price`, { price_cents: 25000 });
put = calls.filter(c => c.method === "PUT").pop();
ok("raise with offers on: price and auto-accept move together", r.status === 200 && put.body.pricingSummary.price.value === "250.00"
  && put.body.listingPolicies.bestOfferTerms.autoAcceptPrice.value === "225.00" && row().p === 25000 && row().a === 22500, { r: r.json, row: row() });
ok("item price follows", db.raw.prepare("SELECT price_cents p FROM items WHERE id=?").get(id).p === 25000);
r = await call("POST", `/api/ebay/listings/${lid}/price`, { price_cents: 20000 });
ok("lower works on the same route", r.status === 200 && row().p === 20000 && row().a === 18000, row());
ok("same price: no eBay call", (await call("POST", `/api/ebay/listings/${lid}/price`, { price_cents: 20000 })).json.unchanged === true);
ok("under $0.99 refused", (await call("POST", `/api/ebay/listings/${lid}/price`, { price_cents: 50 })).status === 400);
ok("someone else's listing -> 404", (await call("POST", `/api/ebay/listings/nope/price`, { price_cents: 1000 })).status === 404);
ok("the slow-listing route still only lowers", (await call("POST", `/api/ebay/slow/${lid}/lower`, { price_cents: 30000 })).status === 400);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
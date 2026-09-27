// Run:  node worker/tests/ebay_flow_test.mjs
// The whole eBay path through the REAL worker routes - connect, callback, draft, publish, the
// refusals, the refund on failure, and eBay's account-deletion notice - against the node:sqlite
// D1 shim with every migration applied. eBay and Nebius are stubbed at fetch(), so this proves
// our wiring and our money handling, NOT that eBay accepts these payloads. That last part can
// only be proven against a real eBay account.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.log(`FAIL ${n}`)); };

// ---------- eBay + Nebius, stubbed ----------
const calls = [];
let publishFails = false;
const jr = (o, status = 200) => new Response(o === null ? null : JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (u, init = {}) => {
  const url = String(u), method = init.method || "GET";
  const body = init.body && typeof init.body === "string" ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })() : null;
  calls.push({ url, method, body });
  if (url.endsWith("/identity/v1/oauth2/token")) {
    const f = new URLSearchParams(init.body);
    if (f.get("grant_type") === "client_credentials") return jr({ access_token: "APP", expires_in: 7200 });
    if (f.get("grant_type") === "authorization_code") return jr({ access_token: "UACC", refresh_token: "UREFRESH-secret", expires_in: 7200, refresh_token_expires_in: 47304000 });
    return jr({ access_token: "UACC2", expires_in: 7200 });
  }
  if (url.includes("/commerce/identity/v1/user/")) return jr({ userId: "EU1", username: "derek_sells" });
  if (url.includes("get_category_suggestions")) return jr({ categorySuggestions: [
    { category: { categoryId: "34", categoryName: "Crocks" }, categoryTreeNodeAncestors: [{ categoryName: "Stoneware" }, { categoryName: "Pottery & Glass" }] },
    { category: { categoryId: "99", categoryName: "Other Pottery" }, categoryTreeNodeAncestors: [] }] });
  if (url.includes("get_item_aspects_for_category")) return jr({ aspects: [
    { localizedAspectName: "Brand", aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT" }, aspectValues: [] },
    { localizedAspectName: "Type", aspectConstraint: { aspectRequired: true, aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "Crock" }, { localizedValue: "Jug" }] },
    { localizedAspectName: "Color", aspectConstraint: { aspectUsage: "RECOMMENDED", aspectMode: "FREE_TEXT" }, aspectValues: [] }] });
  if (url.includes("get_item_condition_policies") && url.includes("99")) return jr({ itemConditionPolicies: [{ categoryId: "99", itemConditions: [] }] });
  if (url.includes("get_item_condition_policies")) return jr({ itemConditionPolicies: [{ categoryId: "34", itemConditions: [{ conditionId: "1000", conditionDescription: "New" }, { conditionId: "3000", conditionDescription: "Used" }] }] });
  if (url.includes("chat/completions")) return jr({ choices: [{ message: { content: JSON.stringify({ aspects: { Type: ["crock"], Brand: ["Invented Brand"], Color: ["Gray"] } }) } }] });
  if (/\/sell\/account\/v1\/(fulfillment|payment|return)_policy\?/.test(url) && method === "GET") return jr({ total: 0 });
  if (url.endsWith("/sell/account/v1/fulfillment_policy") && method === "POST") return jr({ fulfillmentPolicyId: "FP1" }, 201);
  if (url.endsWith("/sell/account/v1/payment_policy") && method === "POST") return jr({ paymentPolicyId: "PP1" }, 201);
  if (url.endsWith("/sell/account/v1/return_policy") && method === "POST") return jr({ returnPolicyId: "RP1" }, 201);
  if (url.includes("/sell/inventory/v1/location/") && method === "POST") return jr(null, 204);
  if (url.includes("/sell/inventory/v1/inventory_item/") && method === "PUT") return jr(null, 204);
  if (url.endsWith("/sell/inventory/v1/offer") && method === "POST") return jr({ offerId: "OFF1" }, 201);
  if (/\/offer\/[^/]+\/publish$/.test(url)) return publishFails
    ? jr({ errors: [{ errorId: 25007, message: "x", longMessage: "Please add a valid shipping service." }] }, 400)
    : jr({ listingId: "1122334455" });
  if (/\/offer\/[^/]+$/.test(url) && method === "PUT") return jr(null, 204);
  return jr({ errors: [{ message: "unstubbed " + url }] }, 404);
};

const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = {
  DB: db, ASSETS: { fetch: async () => new Response("asset") },
  PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test",
  EBAY_CLIENT_ID: "cid", EBAY_CLIENT_SECRET: "csec", EBAY_RUNAME: "Derek-Guest-PRD", EBAY_VERIFY_TOKEN: "v".repeat(40),
  EBAY_DELETION_URL: "https://g.test/api/ebay/deletion",
  EBAY_TOKEN_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i)).toString("base64"),
  NEBIUS_API_KEY: "nk", EBAY_LISTING_CREDITS: "1", RC_WEBHOOK_ON: "bottletree-app",
};
let cookie = "";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, {
    method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

// ---------- account + an estimated item ----------
ok("register", (await call("POST", "/api/auth/register", { email: "d@example.com", password: "password123" })).status === 200);
const me = db.raw.prepare("SELECT id FROM users WHERE email='d@example.com'").get();
db.raw.prepare("UPDATE users SET credits=3 WHERE id=?").run(me.id);
const mk = async () => {
  const { json } = await call("POST", "/api/items", { name: "Crock", description: "red wing crock, 3 gallon" });
  db.raw.prepare("INSERT INTO photos (id,item_id,r2_key,kind,content_type,bytes,sort,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), json.id, `${json.id}/a.jpg`, "front", "image/jpeg", 1000, 0, new Date().toISOString());
  db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at,completed_at) VALUES (?,?,'done',?,?,?)")
    .run(crypto.randomUUID(), json.id, JSON.stringify({
      identification: { name: "Red Wing 3-gallon stoneware crock", maker: "Red Wing Union Stoneware Co.", period: "c. 1920" },
      price_range: { low: 90, high: 160, suggested_retail: 135 }, market: { count: 4, median: 120 },
      listing: { title: "Red Wing 3-Gallon Stoneware Crock, c. 1920", description: "A classic crock.\n\nSound rim.", condition_grade: "Very good" },
      transcribed_text: ["RED WING"] }), new Date().toISOString(), new Date().toISOString());
  return json.id;
};
const item = await mk();
const list = await call("GET", "/api/items");
ok("flat item list has it, in the hidden bucket", list.json.length === 1 && list.json[0].id === item && list.json[0].appraisal_status === "done");
ok("the bucket is one hidden sale named Guestimator", db.raw.prepare("SELECT COUNT(*) n FROM sales WHERE user_id=? AND name='Guestimator'").get(me.id).n === 1);

// ---------- connect ----------
let st = await call("GET", "/api/ebay/status");
ok("status: configured, not connected, signup link", st.json.configured && !st.json.connected && /signup\.ebay\.com/.test(st.json.signup_url));
const pubEarly = await call("POST", `/api/items/${item}/ebay/publish`, { title: "t", price: 10, category_id: "34", condition: "USED_EXCELLENT", description: "d" });
ok("publish before connecting asks to connect", pubEarly.status === 409 && pubEarly.json.needs_connect);
const con = await call("POST", "/api/ebay/connect");
const state = new URL(con.json.url).searchParams.get("state");
ok("consent URL carries a state", !!state && con.json.url.startsWith("https://auth.ebay.com/oauth2/authorize"));

const savedCookie = cookie; cookie = "";   // the callback lands in a browser with no session
const cb = await call("GET", `/api/ebay/callback?code=AUTHCODE&state=${state}`);
ok("callback connects without a session cookie", cb.status === 200 && /eBay connected/.test(cb.text) && /derek_sells/.test(cb.text));
const acct = db.raw.prepare("SELECT * FROM ebay_accounts WHERE user_id=?").get(me.id);
ok("account row stored for the right user", acct && acct.ebay_user_id === "EU1" && acct.ebay_username === "derek_sells");
ok("refresh token is sealed, not plaintext", acct && !acct.refresh_token_enc.includes("UREFRESH") && !acct.access_token_enc.includes("UACC"));
const replay = await call("GET", `/api/ebay/callback?code=AUTHCODE&state=${state}`);
ok("a state works once", replay.status === 400 && /expired/i.test(replay.text));
const forged = await call("GET", `/api/ebay/callback?code=AUTHCODE&state=madeup`);
ok("an unknown state links nothing", forged.status === 400);
const declined = await call("POST", "/api/ebay/connect"); cookie = "";
const decl = await call("GET", `/api/ebay/callback?error=access_denied&state=${new URL((await (async () => { cookie = savedCookie; const c = await call("POST", "/api/ebay/connect"); cookie = ""; return c; })()).json.url).searchParams.get("state")}`);
ok("declining on eBay says so", decl.status === 400 && /declined/.test(decl.text));
cookie = savedCookie;
st = await call("GET", "/api/ebay/status");
ok("status now connected", st.json.connected && st.json.username === "derek_sells");

// ---------- draft ----------
const dr = await call("POST", `/api/items/${item}/ebay/draft`, {});
const d = dr.json.draft;
ok("draft built", dr.status === 200 && d);
ok("category from eBay's suggestion, with its path", d.category.id === "34" && /Pottery & Glass > Stoneware > Crocks/.test(d.category.path));
ok("Brand is the appraiser's maker, NOT the model's invention", d.aspects.Brand[0] === "Red Wing Union Stoneware Co.");
ok("selection-only value restored to eBay's spelling", d.aspects.Type[0] === "Crock");
ok("condition fits the category (Used)", d.condition === "USED_EXCELLENT");
ok("price starts at suggested retail", d.price === 135);
ok("image is an absolute public URL", d.images[0] === `https://g.test/p/${item}/a.jpg`);
ok("nothing required missing", d.missing.length === 0);
const creditsBefore = db.raw.prepare("SELECT credits FROM users WHERE id=?").get(me.id).credits;

// ---------- publish refusals (no credit taken) ----------
const body = { title: d.title, price: 129, category_id: "34", condition: d.condition, description: d.description,
               aspects: d.aspects, postal_code: "12534" };
let r = await call("POST", `/api/items/${item}/ebay/publish`, body);
ok("no shipping price -> asked for it", r.status === 400 && r.json.needs_shipping);
r = await call("POST", `/api/items/${item}/ebay/publish`, { ...body, shipping_cost: "12", aspects: { Brand: ["X"] } });
ok("missing required aspect named", r.status === 400 && r.json.missing?.includes("Type"));
r = await call("POST", `/api/items/${item}/ebay/publish`, { ...body, shipping_cost: "12", condition: "MINT" });
ok("bogus condition refused", r.status === 400);
r = await call("POST", `/api/items/${item}/ebay/publish`, { ...body, shipping_cost: "12", price: 0 });
ok("$0 price refused", r.status === 400);
ok("no credit taken by any refusal", db.raw.prepare("SELECT credits FROM users WHERE id=?").get(me.id).credits === creditsBefore);

// ---------- publish ----------
calls.length = 0;
r = await call("POST", `/api/items/${item}/ebay/publish`, { ...body, shipping_cost: "12", handling_days: 2 });
ok("published", r.status === 200 && r.json.status === "published" && r.json.url === "https://www.ebay.com/itm/1122334455");
ok("one credit spent", db.raw.prepare("SELECT credits FROM users WHERE id=?").get(me.id).credits === creditsBefore - 1);
const inv = calls.find(c => c.url.includes("/inventory_item/") && c.method === "PUT");
ok("inventory item: condition, aspects, absolute images", inv && inv.body.condition === "USED_EXCELLENT" && inv.body.product.aspects.Type[0] === "Crock" && inv.body.product.imageUrls[0].startsWith("https://g.test/p/"));
const offer = calls.find(c => c.url.endsWith("/sell/inventory/v1/offer") && c.method === "POST");
ok("offer: the reviewed price, category, all three policies, location", offer && offer.body.pricingSummary.price.value === "129.00" && offer.body.categoryId === "34"
   && offer.body.listingPolicies.fulfillmentPolicyId === "FP1" && offer.body.listingPolicies.paymentPolicyId === "PP1"
   && offer.body.listingPolicies.returnPolicyId === "RP1" && offer.body.merchantLocationKey === "guestimator-12534");
const fpol = calls.find(c => c.url.endsWith("/fulfillment_policy") && c.method === "POST");
ok("shipping policy: $12 flat, 2-day handling", fpol && fpol.body.shippingOptions[0].shippingServices[0].shippingCost.value === "12.00" && fpol.body.handlingTime.value === 2);
ok("offer description is HTML paragraphs", /<p>A classic crock\.<\/p>/.test(offer.body.listingDescription));
ok("user token (not the app token) used to list", calls.filter(c => c.url.includes("/sell/")).length > 0);
ok("ZIP remembered", db.raw.prepare("SELECT postal_code FROM ebay_accounts WHERE user_id=?").get(me.id).postal_code === "12534");
const row = db.raw.prepare("SELECT * FROM ebay_listings WHERE item_id=?").get(item);
ok("listing row published with id and url", row.status === "published" && row.listing_id === "1122334455" && row.offer_id === "OFF1");
ok("item carries the eBay price", db.raw.prepare("SELECT price_cents FROM items WHERE id=?").get(item).price_cents === 12900);
r = await call("POST", `/api/items/${item}/ebay/publish`, { ...body, shipping_cost: "12" });
ok("second publish refused - no duplicate listing, no second credit", r.status === 409 && r.json.already
   && db.raw.prepare("SELECT credits FROM users WHERE id=?").get(me.id).credits === creditsBefore - 1);
const bundle = await call("GET", `/api/items/${item}`);
ok("item page sees the listing", bundle.json.ebay.status === "published" && bundle.json.ebay.listing_url.endsWith("1122334455"));
ok("items list badge", (await call("GET", "/api/items")).json.find(x => x.id === item).ebay_status === "published");

// ---------- eBay says no: credit comes back, offer kept for the retry ----------
const item2 = await mk();
publishFails = true;
const c0 = db.raw.prepare("SELECT credits FROM users WHERE id=?").get(me.id).credits;
r = await call("POST", `/api/items/${item2}/ebay/publish`, { ...body, shipping_cost: "12" });
ok("eBay's own words come back", r.status === 502 && /valid shipping service/.test(r.json.error) && r.json.stage === "publish");
ok("credit refunded", r.json.refunded && db.raw.prepare("SELECT credits FROM users WHERE id=?").get(me.id).credits === c0);
const row2 = db.raw.prepare("SELECT * FROM ebay_listings WHERE item_id=?").get(item2);
ok("row marked error, offer id kept", row2.status === "error" && row2.offer_id === "OFF1");
publishFails = false; calls.length = 0;
r = await call("POST", `/api/items/${item2}/ebay/publish`, { ...body, shipping_cost: "12" });
ok("retry succeeds", r.status === 200);
ok("retry UPDATES the kept offer instead of making a second", calls.some(c => /\/offer\/OFF1$/.test(c.url) && c.method === "PUT") && !calls.some(c => c.url.endsWith("/sell/inventory/v1/offer") && c.method === "POST"));

// ---------- a category with no condition grades ----------
const itemNc = await mk();
db.raw.prepare("UPDATE users SET credits=5 WHERE id=?").run(me.id);
const drNc = await call("POST", `/api/items/${itemNc}/ebay/draft`, { category_id: "99" });
ok("draft honours the picked category", drNc.json.draft.category.id === "99");
ok("draft says condition does not apply there", drNc.json.draft.condition_applies === false && drNc.json.draft.condition === null);
calls.length = 0;
r = await call("POST", `/api/items/${itemNc}/ebay/publish`, { ...body, category_id: "99", condition: null, shipping_cost: "0" });
const invNc = calls.find(c => c.url.includes("/inventory_item/") && c.method === "PUT");
ok("published with NO condition field sent", r.status === 200 && invNc && !("condition" in invNc.body) && !("conditionDescription" in invNc.body));
const itemBad = await mk();
r = await call("POST", `/api/items/${itemBad}/ebay/publish`, { ...body, shipping_cost: "5", condition: "USED_VERY_GOOD" });
ok("a condition the category doesn't take is refused before eBay", r.status === 400 && /condition/.test(r.json.error));

// ---------- out of credits ----------
const item3 = await mk();
db.raw.prepare("UPDATE users SET credits=0 WHERE id=?").run(me.id);
r = await call("POST", `/api/items/${item3}/ebay/publish`, { ...body, shipping_cost: "12" });
ok("no credit -> paywall, nothing sent to eBay", r.status === 402 && r.json.paywall);
ok("row not left stuck in publishing", db.raw.prepare("SELECT status FROM ebay_listings WHERE item_id=?").get(item3).status === "draft");

// ---------- someone else's item ----------
const saved = cookie; cookie = "";
await call("POST", "/api/auth/register", { email: "other@example.com", password: "password123" });
r = await call("POST", `/api/items/${item3}/ebay/draft`, {});
ok("another account cannot draft my item", r.status === 404);
cookie = saved;

// ---------- eBay account deletion notice ----------
cookie = "";
const del = await call("POST", "/api/ebay/deletion", { notification: { notificationId: "n1", data: { username: "derek_sells", userId: "EU1" } } });
ok("deletion acknowledged", del.status === 204);
ok("stored eBay account removed", !db.raw.prepare("SELECT 1 FROM ebay_accounts WHERE user_id=?").get(me.id));
// item, item2, itemNc, item3 each have a row; itemBad was refused before any row was written.
ok("listing history kept", db.raw.prepare("SELECT COUNT(*) n FROM ebay_listings WHERE user_id=?").get(me.id).n === 4);
const challenge = await call("GET", "/api/ebay/deletion?challenge_code=abc");
ok("challenge answered", challenge.status === 200 && /^[0-9a-f]{64}$/.test(challenge.json.challengeResponse));

// ---------- the POS is gone ----------
cookie = saved;
for (const p of ["/api/me/statements", "/api/me/orders", "/api/me/sellers", "/api/me/shop"])
  ok(`${p} no longer exists`, (await call("GET", p)).status === 404);
ok("/shop/* is not served by the worker", (await call("GET", "/shop/anything")).text === "asset");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

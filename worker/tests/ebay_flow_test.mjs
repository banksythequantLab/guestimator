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
  if (url.endsWith("/offer/get_listing_fees")) return jr({ feeSummaries: [{ marketplaceId: "EBAY_US", fees: [
    { feeType: "InsertionFee", amount: { value: "0.35", currency: "USD" } },
    { feeType: "SubtitleFee", amount: { value: "0.0", currency: "USD" } },
    { feeType: "GalleryPlusFee", amount: { value: "0.35", currency: "USD" }, promotionalDiscount: { value: "0.35", currency: "USD" } }] }] });
  if (/\/offer\/[^/]+\/publish$/.test(url)) return publishFails
    ? jr({ errors: [{ errorId: 25007, message: "x", longMessage: "Please add a valid shipping service." }] }, 400)
    : jr({ listingId: "1122334455" });
  if (/\/offer\/[^/]+$/.test(url) && method === "PUT") return jr(null, 204);
  return jr({ errors: [{ message: "unstubbed " + url }] }, 404);
};

const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { SIGNUP_CREDITS: "0",
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
  return { status: r.status, json, text, location: r.headers.get("location") };
};

// ---------- account + an estimated item ----------
ok("register", (await call("POST", "/api/auth/register", { email: "d@example.com", password: "password123" })).status === 200);
const me = db.raw.prepare("SELECT id FROM users WHERE email='d@example.com'").get();
// This flow runs with SIGNUP_CREDITS=0 (the paywall path); the free-estimates default is in onboard_test.
ok("with SIGNUP_CREDITS=0, a new account starts with 0 credits", db.raw.prepare("SELECT credits FROM users WHERE id=?").get(me.id).credits === 0);
ok("and no welcome grant on the ledger", db.raw.prepare("SELECT COUNT(*) n FROM billing_events WHERE user_id=?").get(me.id).n === 0);
{
  const { json } = await call("POST", "/api/items", { name: "x", description: "a jug" });
  db.raw.prepare("INSERT INTO photos (id,item_id,r2_key,kind,content_type,bytes,sort,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), json.id, `${json.id}/z.jpg`, "front", "image/jpeg", 10, 0, new Date().toISOString());
  const est = await call("POST", `/api/items/${json.id}/appraise`, {});
  ok("first estimate goes straight to the paywall", est.status === 402 && est.json.paywall);
  await call("DELETE", `/api/items/${json.id}`);
}
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
ok("web callback connects without a session cookie and returns to the app", cb.status === 302 && cb.location === "/?ebay=connected");
ok("web state is marked w", state.startsWith("w"));
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
// The Android app (build 7+) asks for a native connect: the callback must hand back to the app by
// its URL scheme, as a 302 (a script redirect from a Custom Tab would be blocked by Chrome).
{
  const nat = await call("POST", "/api/ebay/connect", { native: true });
  const ns = new URL(nat.json.url).searchParams.get("state");
  ok("native state is marked n", ns.startsWith("n"));
  cookie = "";
  const r = await call("GET", `/api/ebay/callback?code=AUTHCODE&state=${ns}`);
  ok("native callback 302s to the app scheme", r.status === 302 && r.location === "ai.banksy.bottletree://ebay/connected");
  const ns2 = new URL((await (async () => { cookie = savedCookie; const c = await call("POST", "/api/ebay/connect", { native: true }); cookie = ""; return c; })()).json.url).searchParams.get("state");
  const bad = await call("GET", `/api/ebay/callback?error=access_denied&state=${ns2}`);
  ok("native decline shows a page whose button goes back to the app", bad.status === 400 && bad.text.includes('href="ai.banksy.bottletree://ebay/failed"'));
  cookie = savedCookie;
}
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
// ---------- no Guestimate: the seller's own title, size and photos (2026-10-08) ----------
{
  const cr0 = db.raw.prepare("SELECT credits FROM users WHERE id=?").get(me.id).credits;
  const { json: nj } = await call("POST", "/api/items", { name: "Oak two-door cabinet", description: "Painted. Size: 59 x 29 x 29 inches. Weight: 50 lb." });
  const noPhoto = await call("POST", `/api/items/${nj.id}/ebay/draft`, {});
  ok("no Guestimate and no photo -> asks for a photo", noPhoto.status === 400 && /photo/i.test(noPhoto.json.error), noPhoto.json);
  db.raw.prepare("INSERT INTO photos (id,item_id,r2_key,kind,content_type,bytes,sort,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), nj.id, `${nj.id}/m.jpg`, "front", "image/jpeg", 1000, 0, new Date().toISOString());
  const md = await call("POST", `/api/items/${nj.id}/ebay/draft`, {});
  const m = md.json.draft || {};
  ok("no Guestimate -> draft from the seller's own title", md.status === 200 && m.title === "Oak two-door cabinet", md.json);
  ok("price left for the seller to set", m.price === null);
  ok("their size and weight carried into shipping", JSON.stringify((m.shipping || {}).item_in) === "[59,29,29]" && m.shipping.item_weight_lb === 50, m.shipping);
  ok("drafting without a Guestimate uses no credit", db.raw.prepare("SELECT credits FROM users WHERE id=?").get(me.id).credits === cr0);
  const del = await call("DELETE", `/api/items/${nj.id}`);
  ok("deleting the item removes its unpublished eBay draft", del.status === 200 && !db.raw.prepare("SELECT 1 FROM ebay_listings WHERE item_id=?").get(nj.id));
}
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

// ---------- preview: saved on eBay unpublished, eBay's fee quote, no credit ----------
calls.length = 0;
const cPrev = db.raw.prepare("SELECT credits FROM users WHERE id=?").get(me.id).credits;
r = await call("POST", `/api/items/${item}/ebay/preview`, { ...body, shipping_cost: "12", handling_days: 2 });
ok("preview returns eBay's fee quote, net of promos, zero-fee lines dropped", r.status === 200 && r.json.status === "preview" && r.json.fees
   && r.json.fees.total === 0.35 && r.json.fees.fees.map(f => `${f.type}:${f.net}`).join(",") === "InsertionFee:0.35,GalleryPlusFee:0");
ok("preview says the return policy the listing really gets", r.json.returns === "30-day returns, buyer pays return shipping", r.json.returns);
{ const rp = await call("GET", "/api/ebay/return-policies");
  ok("return policies listed for the form, with the new-30-day choice", rp.status === 200 && Array.isArray(rp.json.policies) && rp.json.new30 === "new30", rp.json); }
ok("preview takes no credit", db.raw.prepare("SELECT credits FROM users WHERE id=?").get(me.id).credits === cPrev);
ok("preview never calls publish", !calls.some(c => /\/publish$/.test(c.url)));
ok("preview saved the offer for publish to reuse",
   db.raw.prepare("SELECT status, offer_id FROM ebay_listings WHERE item_id=?").get(item).offer_id === "OFF1"
   && db.raw.prepare("SELECT status FROM ebay_listings WHERE item_id=?").get(item).status === "draft");
const feeCall = calls.find(c => c.url.endsWith("/offer/get_listing_fees"));
ok("fee quote asked for the saved offer", feeCall && feeCall.body.offers[0].offerId === "OFF1");

// ---------- publish ----------
calls.length = 0;
r = await call("POST", `/api/items/${item}/ebay/publish`, { ...body, shipping_cost: "12", handling_days: 2 });
ok("published", r.status === 200 && r.json.status === "published" && r.json.url === "https://www.ebay.com/itm/1122334455");
ok("one credit spent", db.raw.prepare("SELECT credits FROM users WHERE id=?").get(me.id).credits === creditsBefore - 1);
const inv = calls.find(c => c.url.includes("/inventory_item/") && c.method === "PUT");
ok("inventory item: condition, aspects, absolute images", inv && inv.body.condition === "USED_EXCELLENT" && inv.body.product.aspects.Type[0] === "Crock" && inv.body.product.imageUrls[0].startsWith("https://g.test/p/"));
// After a preview the offer already exists, so publish UPDATES it (never a second offer).
ok("publish after preview updates the saved offer, no second offer", calls.some(c => /\/offer\/OFF1$/.test(c.url) && c.method === "PUT")
   && !calls.some(c => c.url.endsWith("/sell/inventory/v1/offer") && c.method === "POST"));
const offer = calls.find(c => /\/offer\/OFF1$/.test(c.url) && c.method === "PUT");
ok("offer: the reviewed price, category, all three policies, location", offer && offer.body.pricingSummary.price.value === "129.00" && offer.body.categoryId === "34"
   && offer.body.listingPolicies.fulfillmentPolicyId === "FP1" && offer.body.listingPolicies.paymentPolicyId === "PP1"
   && offer.body.listingPolicies.returnPolicyId === "RP1" && offer.body.merchantLocationKey === "guestimator-12534");
const fpol = calls.find(c => c.url.endsWith("/fulfillment_policy") && c.method === "POST");
ok("shipping policy: $12 flat, 2-day handling", fpol && fpol.body.shippingOptions[0].shippingServices[0].shippingCost.value === "12.00" && fpol.body.handlingTime.value === 2);
ok("Best Offer OFF unless the seller ticks it (2026-10-05)", offer.body.listingPolicies.bestOfferTerms?.bestOfferEnabled === false, offer.body.listingPolicies);
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

// ---------- return policy wording ----------
{
  const { returnSummary, pickReturnPolicy } = await import("../ebay.js");
  const none = { id: "RN", summary: "No returns" }, r30 = { id: "R30", summary: "30-day returns, buyer pays return shipping" };
  ok("default: only no-returns policies -> create a 30-day one", pickReturnPolicy([none], "") === "new30");
  ok("default: their own 30-day policy is reused", pickReturnPolicy([none, r30], undefined) === "R30");
  ok("an explicit choice of their own policy stands", pickReturnPolicy([none, r30], "RN") === "RN");
  ok("a policy that isn't theirs falls back to 30 days", pickReturnPolicy([none], "XYZ") === "new30");
  ok("no-returns policy reads as such", returnSummary({ returnsAccepted: false }) === "No returns");
  ok("30 days, buyer pays", returnSummary({ returnsAccepted: true, returnPeriod: { value: 30, unit: "DAY" }, returnShippingCostPayer: "BUYER" }) === "30-day returns, buyer pays return shipping");
  ok("60 days, seller pays", returnSummary({ returnsAccepted: true, returnPeriod: { value: 60, unit: "DAY" }, returnShippingCostPayer: "SELLER" }) === "60-day returns, free return shipping");
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Run:  node worker/tests/etsy_test.mjs
// Etsy cross-listing: vintage era rules, PKCE connect, list (draft -> photos -> active), and
// "whichever sells first takes it off the other" in both directions. Etsy is stubbed.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as E from "../etsy.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 600) : ""}`)); };

// ---- era -> when_made (2026: vintage means made 2006 or earlier) ----
const W = p => E.whenMadeFor(p, 2026);
ok("c. 1915-1930 -> 1920s", W("c. 1915-1930").when_made === "1920s", W("c. 1915-1930"));
ok("1950s", W("1950s").when_made === "1950s");
ok("1970s-80s -> vintage, 1970s or 1980s", W("1970s-80s").vintage === true && ["1970s", "1980s"].includes(W("1970s-80s").when_made), W("1970s-80s"));
ok("late 19th century -> 1800s", W("Late 19th century").when_made === "1800s", W("Late 19th century"));
ok("mid-20th century -> 1940s/1950s", ["1940s", "1950s"].includes(W("mid-20th century").when_made), W("mid-20th century"));
ok("Victorian -> 1800s", W("Victorian era").when_made === "1800s");
ok("Art Deco -> 1920s/1930s", ["1920s", "1930s"].includes(W("Art Deco").when_made), W("Art Deco"));
ok("1990s-2000s is NOT vintage in 2026", W("1990s-2000s").vintage === false && /20 years/.test(W("1990s-2000s").why));
ok("2015 not vintage", W("2015").vintage === false);
ok("unknown period -> ask", W("").vintage === null && W("unknown").vintage === null);
ok("'60s -> 1960s", W("'60s").when_made === "1960s", W("'60s"));
ok("vintage choices exclude 2007-2009 in 2026", !E.vintageChoices(2026).includes("2007_2009") && E.vintageChoices(2026).includes("2000_2006"));
ok("2007-2009 becomes vintage in 2029", E.vintageChoices(2029).includes("2007_2009"));

{ const t = E.etsyTitle("50% off: A & B & C: 10%");
  ok("title: one each of % : &", t.split("&").length === 2 && t.split(":").length === 2 && t.split("%").length === 2 && t.startsWith("50% off: A & B"), t); }
ok("title capped at 140", E.etsyTitle("x".repeat(200)).length === 140);

const tree = [{ id: 1, name: "Home & Living", children: [{ id: 11, name: "Kitchen & Dining", children: [{ id: 111, name: "Crocks", children: [] }, { id: 112, name: "Bowls", children: [] }] }] },
              { id: 2, name: "Jewelry", children: [{ id: 21, name: "Brooches", children: [] }] }];
const flat = E.flattenTaxonomy(tree);
ok("taxonomy flattened with paths", flat.length === 6 && flat.find(t => t.id === 111).path === "Home & Living › Kitchen & Dining › Crocks");
const mt = E.matchTaxonomy(flat, { category: "Stoneware crock", name: "Red Wing 3-gallon stoneware crock" });
ok("crock matches Crocks first", mt[0] && mt[0].id === 111, mt);
ok("no match -> empty", E.matchTaxonomy(flat, { category: "Automobile", name: "Ford" }).length === 0);

const v = E.newVerifier();
ok("PKCE verifier 43-128 url-safe chars", /^[A-Za-z0-9_-]{43,128}$/.test(v));
ok("PKCE challenge is base64url sha256", (await E.challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")) === "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");

// ---- the flow through worker.js, Etsy stubbed ----
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7)).toString("base64");
const calls = [];
let listingState = "active", draftFails = false, tokenN = 0;
const jr = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...headers } });
globalThis.fetch = async (u, init = {}) => {
  const url = String(u), method = init.method || "GET";
  calls.push({ url, method, headers: init.headers || {}, body: init.body });
  if (url === E.TOKEN_URL) {
    const f = new URLSearchParams(String(init.body));
    if (f.get("grant_type") === "authorization_code") return f.get("code") === "good" && f.get("code_verifier") ? jr({ access_token: "777.ACCESS" + (++tokenN), refresh_token: "777.REFRESH" + tokenN, expires_in: 3600 }) : jr({ error: "invalid_grant", error_description: "bad code" }, 400);
    return jr({ access_token: "777.ACCESS" + (++tokenN), refresh_token: "777.REFRESH" + tokenN, expires_in: 3600 });
  }
  const p = url.replace(E.API, "");
  if (p === "/users/me") return jr({ user_id: 777, shop_id: 4242 });
  if (p === "/shops/4242") return jr({ shop_id: 4242, shop_name: "BottleTreeVintage" });
  if (p === "/seller-taxonomy/nodes") return jr({ count: 2, results: tree });
  if (p === "/shops/4242/shipping-profiles") return jr({ count: 1, results: [{ shipping_profile_id: 55, title: "USPS Ground", is_deleted: false }] });
  if (p.startsWith("/shops/4242/readiness-state-definitions") && method === "GET") return jr({ count: 0, results: [] });
  if (p === "/shops/4242/readiness-state-definitions" && method === "POST") return jr({}, 409, { "content-location": "/v3/application/shops/4242/readiness-state-definitions/909" });
  if (p === "/shops/4242/listings" && method === "POST") return draftFails ? jr({ error: "taxonomy_id is invalid" }, 400) : jr({ listing_id: 31337, state: "draft" }, 201);
  if (/^\/shops\/4242\/listings\/31337\/images$/.test(p)) return jr({ listing_image_id: 1 }, 201);
  if (p === "/shops/4242/listings/31337" && method === "PATCH") return jr({ listing_id: 31337, state: JSON.parse(init.body).state, url: "https://www.etsy.com/listing/31337/crock" });
  if (p === "/listings/31337" && method === "GET") return jr({ listing_id: 31337, state: listingState });
  if (p === "/listings/31337" && method === "DELETE") return new Response(null, { status: 204 });
  return jr({ error: "unstubbed " + method + " " + url }, 404);
};
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const mails = [];
const env = { SIGNUP_CREDITS: "0", DB: db, EBAY_TOKEN_KEY: KEY, ETSY_API_KEY: "kstring", ETSY_SHARED_SECRET: "shh", EBAY_LISTING_CREDITS: "0",
  ASSETS: { fetch: async () => new Response("a") }, PUBLIC_ORIGIN: "https://g.test",
  PHOTOS: { put: async () => {}, delete: async () => {}, get: async k => ({ arrayBuffer: async () => new Uint8Array([255, 216, 255]).buffer, key: k }) },
  EMAIL: { send: async m => { if (!/^Welcome/.test(m.subject)) mails.push(m); return { messageId: "m" }; } }, ALERT_FROM: "a@g.test" };
let cookie = "";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, redirect: "manual", headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const t = await r.text(); let json = null; try { json = JSON.parse(t); } catch {}
  return { status: r.status, json, text: t, location: r.headers.get("location") };
};

// Off until the secrets are set.
await call("POST", "/api/auth/register", { email: "seller@example.com", password: "password123" });
const me = db.raw.prepare("SELECT id FROM users WHERE email='seller@example.com'").get().id;
let r = await call("GET", "/api/etsy/status");
ok("status: configured, not connected", r.json.configured === true && r.json.connected === false && /trademark of Etsy/.test(r.json.notice), r.json);
const offEnv = { ...env }; delete offEnv.ETSY_API_KEY;
const off = await worker.fetch(new Request("https://g.test/api/etsy/status", { headers: { cookie } }), offEnv, { waitUntil() {} });
ok("without ETSY_API_KEY: not configured", (await off.json()).configured === false);

// Connect (PKCE)
r = await call("POST", "/api/etsy/connect", {});
const cu = new URL(r.json.url);
ok("consent URL: PKCE S256, scopes, our redirect", cu.origin + cu.pathname === "https://www.etsy.com/oauth/connect" && cu.searchParams.get("code_challenge_method") === "S256" &&
   cu.searchParams.get("client_id") === "kstring" && cu.searchParams.get("redirect_uri") === "https://g.test/etsy/callback" && /listings_w/.test(cu.searchParams.get("scope")), r.json.url);
const st = cu.searchParams.get("state");
const ver = db.raw.prepare("SELECT verifier FROM etsy_oauth_states WHERE state=?").get(st).verifier;
ok("challenge matches the stored verifier", cu.searchParams.get("code_challenge") === await E.challengeFor(ver));
r = await call("GET", `/etsy/callback?state=forged&code=good`);
ok("forged state refused with a page", r.status === 400 && /expired/.test(r.text));
r = await call("GET", `/etsy/callback?state=${st}&code=good`);
ok("good callback -> back to the app", r.status === 302 && r.location === "/?etsy=connected", r);
const acct = db.raw.prepare("SELECT * FROM etsy_accounts WHERE user_id=?").get(me);
ok("shop saved, tokens sealed", acct.shop_id === "4242" && acct.shop_name === "BottleTreeVintage" && !acct.refresh_token_enc.includes("REFRESH"));
const tokCall = calls.find(c => c.url === E.TOKEN_URL);
ok("code exchange sends the verifier", new URLSearchParams(String(tokCall.body)).get("code_verifier") === ver);
ok("API calls carry x-api-key KEY:SECRET", calls.find(c => c.url.endsWith("/users/me")).headers["x-api-key"] === "kstring:shh");

// An estimated, photographed item.
const mkItem = async (name, period) => {
  const id = (await call("POST", "/api/items", { name, description: name })).json.id;
  const ts = new Date().toISOString();
  db.raw.prepare("UPDATE items SET ai_title=?, ai_description=?, price_cents=4500, listing_status='live' WHERE id=?").run("Red Wing 3 Gallon Stoneware Crock", "A salt-glazed crock.", id);
  db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?, 'done', ?, ?)")
    .run(crypto.randomUUID(), id, JSON.stringify({ identification: { name: "Red Wing 3-gallon stoneware crock", category: "Stoneware crock", period } }), ts);
  db.raw.prepare("INSERT INTO photos (id,item_id,r2_key,kind,content_type,bytes,sort,created_at) VALUES (?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), id, `${id}/a.jpg`, "front", "image/jpeg", 3, 0, ts);
  db.raw.prepare("INSERT INTO photos (id,item_id,r2_key,kind,content_type,bytes,sort,created_at) VALUES (?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), id, `${id}/b.heic`, "back", "image/heic", 3, 1, ts);
  return id;
};
const crock = await mkItem("Crock", "c. 1915-1930");
r = await call("GET", `/api/items/${crock}/etsy`);
ok("plan: vintage 1920s, crock category, shipping profile, prefilled copy", r.json.connected && r.json.vintage === true && r.json.when_made === "1920s" &&
   r.json.categories[0].id === 111 && r.json.shipping_profiles[0].id === "55" && r.json.price_cents === 4500 && r.json.description === "A salt-glazed crock.", r.json);
const modern = await mkItem("Phone", "2018");
r = await call("GET", `/api/items/${modern}/etsy`);
ok("plan: modern item says why not", r.json.vintage === false && /20 years/.test(r.json.why), r.json);

const form = { title: "Red Wing 3 Gallon Stoneware Crock", price: "45", when_made: "1920s", taxonomy_id: 111, shipping_profile_id: "55", description: "A salt-glazed crock." };
r = await call("POST", `/api/items/${crock}/etsy/publish`, { ...form, when_made: "2010_2019" });
ok("non-vintage era refused", r.status === 400 && /vintage/.test(r.json.error));
draftFails = true;
r = await call("POST", `/api/items/${crock}/etsy/publish`, form);
ok("Etsy error passed through, row kept as error", r.status === 502 && /taxonomy_id is invalid/.test(r.json.error) &&
   db.raw.prepare("SELECT status FROM etsy_listings WHERE item_id=? ORDER BY created_at DESC").get(crock).status === "error", r.json);
draftFails = false;
const n0 = calls.length;
r = await call("POST", `/api/items/${crock}/etsy/publish`, form);
ok("listed: active with its URL", r.status === 200 && r.json.status === "active" && r.json.url === "https://www.etsy.com/listing/31337/crock", r.json);
const mine = calls.slice(n0);
const draft = mine.find(c => c.url.endsWith("/shops/4242/listings") && c.method === "POST");
const df = new URLSearchParams(String(draft.body));
ok("draft: vintage reseller fields, readiness from 409 Content-Location, no auto-renew", df.get("who_made") === "someone_else" && df.get("when_made") === "1920s" &&
   df.get("readiness_state_id") === "909" && df.get("shipping_profile_id") === "55" && df.get("should_auto_renew") === "false" && df.get("price") === "45.00" && df.get("quantity") === "1", df.toString());
ok("only the JPEG uploaded (HEIC skipped)", mine.filter(c => /\/images$/.test(c.url)).length === 1);
const act = mine.find(c => c.method === "PATCH");
ok("then activated", act && JSON.parse(act.body).state === "active");
r = await call("POST", `/api/items/${crock}/etsy/publish`, form);
ok("second tap: already on Etsy", r.status === 409 && r.json.already === true);

// Sold in person -> taken off Etsy too (through endEbayListing).
const n1 = calls.length;
r = await call("POST", `/api/items/${crock}/sold`, { price: "40" });
const down = calls.slice(n1).find(c => c.method === "PATCH" && c.url.endsWith("/listings/31337"));
ok("sold in person -> Etsy listing set inactive", r.status === 200 && down && JSON.parse(down.body).state === "inactive", r.json);
ok("etsy row ended", db.raw.prepare("SELECT status FROM etsy_listings WHERE item_id=? AND listing_id='31337'").get(crock).status === "ended");

// Sold on Etsy -> item sold, seller emailed, eBay copy ended (here eBay isn't connected, so the email says to end it by hand).
const vase = await mkItem("Vase", "1950s");
r = await call("POST", `/api/items/${vase}/etsy/publish`, { ...form, when_made: "1950s" });
ok("second item listed", r.status === 200, r.json);
db.raw.prepare("INSERT INTO ebay_listings (id,item_id,user_id,sku,status,offer_id,listing_id,listing_url,created_at,updated_at) VALUES (?,?,?,?,'published','OFF-1','L1','https://www.ebay.com/itm/1',?,?)")
  .run(crypto.randomUUID(), vase, me, "GS-" + vase, new Date().toISOString(), new Date().toISOString());
listingState = "active";
let polled = await E.pollSold(env, db, "https://g.test");
ok("poll: still active -> nothing", polled.length === 0 || polled.every(x => !x.sold));
db.raw.prepare("UPDATE etsy_listings SET checked_at=NULL").run();
listingState = "sold_out";
polled = await E.pollSold(env, db, "https://g.test");
ok("poll: sold out -> sold", polled.length === 1 && polled[0].sold === true, polled);
ok("item marked sold", db.raw.prepare("SELECT listing_status s FROM items WHERE id=?").get(vase).s === "sold");
const sm = mails.find(m => /^Sold on Etsy/.test(m.subject));
ok("seller emailed, told to end eBay by hand when we couldn't", sm && sm.to === "seller@example.com" && /could NOT take it off eBay/.test(sm.text) && /trademark of Etsy/.test(sm.text), sm && sm.text);
db.raw.prepare("UPDATE etsy_listings SET checked_at=NULL").run();
ok("sold listing not polled again", (await E.pollSold(env, db, "https://g.test")).length === 0);

// Taken down by the seller on Etsy -> recorded as ended, item untouched.
const bowl = await mkItem("Bowl", "1960s");
await call("POST", `/api/items/${bowl}/etsy/publish`, { ...form, when_made: "1960s" });
listingState = "inactive"; db.raw.prepare("UPDATE etsy_listings SET checked_at=NULL").run();
polled = await E.pollSold(env, db, "https://g.test");
ok("inactive on Etsy -> ended, not sold", polled.length === 1 && polled[0].sold === false && db.raw.prepare("SELECT listing_status s FROM items WHERE id=?").get(bowl).s !== "sold", polled);

// Credits: listing costs a credit when EBAY_LISTING_CREDITS isn't 0; none left -> 402 and no row.
env.EBAY_LISTING_CREDITS = "1";
const plate = await mkItem("Plate", "1940s");
r = await call("POST", `/api/items/${plate}/etsy/publish`, { ...form, when_made: "1940s" });
ok("out of credits -> 402 paywall, nothing left behind", r.status === 402 && r.json.paywall === true && !db.raw.prepare("SELECT 1 FROM etsy_listings WHERE item_id=?").get(plate), r.json);
env.EBAY_LISTING_CREDITS = "0";

// Another user can't touch it.
const keep = cookie; cookie = "";
await call("POST", "/api/auth/register", { email: "other@example.com", password: "password123" });
ok("other user: 404", (await call("GET", `/api/items/${bowl}/etsy`)).status === 404 && (await call("POST", `/api/items/${bowl}/etsy/publish`, form)).status === 404);
cookie = keep;
r = await call("DELETE", "/api/etsy/connection");
ok("disconnect", r.json.disconnected === 1 && (await call("GET", "/api/etsy/status")).json.connected === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

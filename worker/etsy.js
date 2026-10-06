// Etsy cross-listing. A vintage item (20+ years old - the only kind Etsy lets a reseller sell)
// that is listed on eBay can also go up on the seller's own Etsy shop. Whichever sells first
// takes it off the other: endEbayListing() ends the Etsy copy, and the cron poll below notices
// an Etsy sale and ends the eBay copy.
//
// Etsy Open API v3: OAuth 2 with PKCE, `x-api-key: KEY:SHARED_SECRET` on every call. Access
// tokens last an hour; refresh tokens rotate on every refresh and last 90 days. Off until
// ETSY_API_KEY and ETSY_SHARED_SECRET are set (Derek's Etsy app). The term "Etsy" is a
// trademark of Etsy, Inc.; the app shows Etsy's required notice wherever this is offered.

import { seal, unseal } from "./ebay.js";
import { endEbayListing } from "./ebayorders.js";
import { sendAlert } from "./notify.js";

export const API = "https://openapi.etsy.com/v3/application";
export const TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
export const SCOPES = "listings_r listings_w shops_r shops_w";
export const NOTICE = "The term 'Etsy' is a trademark of Etsy, Inc. This application uses the Etsy API but is not endorsed or certified by Etsy, Inc.";
export const SHIPPING_HELP = "https://www.etsy.com/your/shops/me/tools/shipping-profiles";
export const etsyReady = env => !!(env.ETSY_API_KEY && env.ETSY_SHARED_SECRET && env.EBAY_TOKEN_KEY);
// Who sees Etsy (2026-10-06, Derek: "we can't add the feature to a live product until it works for
// everyone"). Until ETSY_OPEN is "on" it is only for ETSY_USERS (comma-separated emails), which
// defaults to the owner (ADMIN_EMAIL, else the first LABEL_USERS address). Everyone else sees
// nothing about Etsy, exactly as if it were switched off.
export function etsyAllowed(env, email) {
  if (String(env.ETSY_OPEN || "").trim() === "on") return true;
  const owner = env.ADMIN_EMAIL || String(env.LABEL_USERS || "").split(",")[0];
  const list = String(env.ETSY_USERS || owner || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return !!email && list.includes(String(email).trim().toLowerCase());
}
export const etsyOnFor = (env, email) => etsyReady(env) && etsyAllowed(env, email);
const redirectUri = env => `${(env.PUBLIC_ORIGIN || "https://app.theguestimator.com").replace(/\/+$/, "")}/etsy/callback`;
const now = () => new Date().toISOString();

// ---------- pure helpers (tests/etsy_test.mjs) ----------

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function newVerifier() { const a = new Uint8Array(48); crypto.getRandomValues(a); return b64url(a); }
export async function challengeFor(verifier) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
export const consentUrl = (env, state, challenge) => "https://www.etsy.com/oauth/connect?" + new URLSearchParams({
  response_type: "code", client_id: env.ETSY_API_KEY, redirect_uri: redirectUri(env), scope: SCOPES,
  state, code_challenge: challenge, code_challenge_method: "S256" }).toString();

// Era words the estimate uses, as [from, to] years.
const ERAS = [
  [/victorian/i, 1837, 1901], [/edwardian/i, 1901, 1914], [/art nouveau/i, 1890, 1914], [/art deco/i, 1920, 1939],
  [/depression/i, 1929, 1939], [/(ww ?ii|world war (2|ii))/i, 1939, 1945], [/(ww ?i\b|world war (1|i)\b)/i, 1914, 1918],
  [/mid[- ]?century/i, 1945, 1969], [/georgian/i, 1714, 1837], [/colonial/i, 1700, 1780],
];
const CENT = { early: [0, 33], mid: [33, 66], late: [66, 99] };
/** The years an estimate's period string covers, as { from, to }, or null when it doesn't say. */
export function periodYears(period) {
  const s = String(period || "").toLowerCase().replace(/[’']/g, "");
  if (!s.trim()) return null;
  // "19th century", "late 19th century", "mid-20th century"
  const c = s.match(/(early|mid|late)?[- ]*(1[5-9]|20)(st|nd|rd|th)[- ]century/);
  if (c) { const base = (Number(c[2]) - 1) * 100, [a, b] = CENT[c[1]] || [0, 99]; return { from: base + a, to: base + b }; }
  // Four-digit years and decades: "c. 1915-1930", "1950s", "1970s-80s", "1880s-1890s"
  const years = [];
  for (const m of s.matchAll(/\b(1[5-9]\d\d|20[0-2]\d)(s)?\b/g)) { const y = Number(m[1]); years.push(y, m[2] ? y + 9 : y); }
  const short = s.match(/\b(1[5-9]\d0|20[0-2]0)s?\s*[-–to]+\s*(\d0)s\b/);
  if (short) years.push(Math.floor(Number(short[1]) / 100) * 100 + Number(short[2]) + 9);
  if (years.length) return { from: Math.min(...years), to: Math.max(...years) };
  for (const m of s.matchAll(/\b(\d)0s\b/g)) years.push(1900 + Number(m[1]) * 10, 1909 + Number(m[1]) * 10);  // "60s"
  if (years.length) return { from: Math.min(...years), to: Math.max(...years) };
  for (const [re, a, b] of ERAS) if (re.test(s)) return { from: a, to: b };
  return null;
}

// Etsy's when_made values a reseller may use (vintage), oldest last. Each is [value, from, to].
export const WHEN_MADE = [
  ["2010_2019", 2010, 2019], ["2007_2009", 2007, 2009], ["2000_2006", 2000, 2006],
  ["1990s", 1990, 1999], ["1980s", 1980, 1989], ["1970s", 1970, 1979], ["1960s", 1960, 1969], ["1950s", 1950, 1959],
  ["1940s", 1940, 1949], ["1930s", 1930, 1939], ["1920s", 1920, 1929], ["1910s", 1910, 1919], ["1900s", 1900, 1909],
  ["1800s", 1800, 1899], ["1700s", 1700, 1799], ["before_1700", 0, 1699],
];
/** The when_made choices that are vintage this year (the whole bucket is 20+ years old). */
export function vintageChoices(nowYear = new Date().getUTCFullYear()) {
  return WHEN_MADE.filter(([, , to]) => to <= nowYear - 20).map(([v]) => v);
}
/**
 * The estimate's period -> Etsy's when_made, if the item is vintage.
 * { when_made, vintage: true } | { vintage: false, why } | { when_made: null, vintage: null } (period unknown).
 * Judged on the LATEST year the period allows, so "1990s-2000s" is not called vintage in 2026.
 */
export function whenMadeFor(period, nowYear = new Date().getUTCFullYear()) {
  const y = periodYears(period);
  if (!y) return { when_made: null, vintage: null };
  if (y.to > nowYear - 20) return { when_made: null, vintage: false, why: `Etsy only lets resellers sell vintage — items at least 20 years old (made ${nowYear - 20} or earlier).` };
  const mid = Math.round((y.from + y.to) / 2);
  const hit = WHEN_MADE.find(([, a, b]) => mid >= a && mid <= b);
  return { when_made: hit ? hit[0] : null, vintage: true };
}

// Etsy titles: up to 140 characters, and %, : and & may each appear only once.
export function etsyTitle(s) {
  let t = String(s || "").replace(/[^\p{L}\p{N}\p{P}\p{Zs}$+]/gu, " ").replace(/\s+/g, " ").trim();
  for (const ch of ["%", ":", "&"]) { let seen = false; t = t.split("").filter(c => c !== ch || (seen ? false : (seen = true))).join(""); }
  return t.slice(0, 140).trim();
}

// The seller taxonomy as a flat list of { id, name, path }.
export function flattenTaxonomy(nodes, trail = []) {
  const out = [];
  for (const n of nodes || []) {
    const path = [...trail, n.name];
    out.push({ id: n.id, name: n.name, path: path.join(" › "), leaf: !(n.children || []).length });
    out.push(...flattenTaxonomy(n.children, path));
  }
  return out;
}
const words = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 2)
  .map(w => w.replace(/(ies)$/, "y").replace(/([^s])s$/, "$1"));
/** Best taxonomy matches for this item, most likely first. Category words count double. */
export function matchTaxonomy(flat, { category = "", name = "" } = {}, n = 6) {
  const cat = new Set(words(category)), nm = new Set(words(name));
  const scored = flat.map(t => {
    const own = words(t.name), path = words(t.path);
    let sc = 0;
    for (const w of own) { if (cat.has(w)) sc += 4; if (nm.has(w)) sc += 3; }
    for (const w of path) { if (cat.has(w)) sc += 1; if (nm.has(w)) sc += 0.5; }
    if (/vintage/i.test(t.path)) sc += 0.5;
    if (t.leaf) sc += 0.25;
    return { ...t, sc };
  }).filter(t => t.sc >= 3);
  scored.sort((a, b) => b.sc - a.sc || a.path.length - b.path.length);
  return scored.slice(0, n).map(({ id, path }) => ({ id, path }));
}

export function etsyErrorText(j, status) {
  const m = j && (j.error_description || j.error || j.message);
  return m ? `Etsy: ${String(m).slice(0, 300)}` : `Etsy said ${status}`;
}

// ---------- Etsy calls ----------

const keyHeader = env => ({ "x-api-key": `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}` });

/** One API call. body: URLSearchParams/object (form), FormData (multipart), or { json }. */
export async function call(env, token, method, path, body) {
  const headers = { ...keyHeader(env) };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body && body.json) { headers["content-type"] = "application/json"; payload = JSON.stringify(body.json); }
  else if (body) { headers["content-type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(body).toString(); }
  const r = await fetch(API + path, { method, headers, body: payload });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json: j, headers: r.headers };
}

async function tokenCall(form) {
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { const e = new Error(etsyErrorText(j, r.status)); e.code = j.error; throw e; }
  return j;
}
export const exchangeCode = (env, code, verifier) =>
  tokenCall({ grant_type: "authorization_code", client_id: env.ETSY_API_KEY, redirect_uri: redirectUri(env), code, code_verifier: verifier });

/** Save a fresh connection: who they are and which shop. Throws when they have no shop. */
export async function saveConnection(env, db, userId, tok) {
  const me = await call(env, tok.access_token, "GET", "/users/me");
  if (!me.ok) throw new Error(etsyErrorText(me.json, me.status));
  if (!me.json.shop_id) throw new Error("That Etsy account has no shop yet. Open a shop on Etsy first, then connect again.");
  const shop = await call(env, tok.access_token, "GET", `/shops/${me.json.shop_id}`);
  const ts = now();
  await db.prepare("INSERT INTO etsy_accounts (user_id,etsy_user_id,shop_id,shop_name,refresh_token_enc,access_token_enc,access_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) " +
    "ON CONFLICT(user_id) DO UPDATE SET etsy_user_id=excluded.etsy_user_id, shop_id=excluded.shop_id, shop_name=excluded.shop_name, refresh_token_enc=excluded.refresh_token_enc, " +
    "access_token_enc=excluded.access_token_enc, access_expires_at=excluded.access_expires_at, readiness_state_id=NULL, updated_at=excluded.updated_at")
    .bind(userId, String(me.json.user_id), String(me.json.shop_id), shop.ok ? (shop.json.shop_name || null) : null,
          await seal(env, tok.refresh_token), await seal(env, tok.access_token), new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(), ts, ts).run();
  return { shop_id: String(me.json.shop_id), shop_name: shop.ok ? shop.json.shop_name : null };
}

/** The seller's access token, refreshed when near expiry. A dead refresh token disconnects. */
export async function userToken(env, db, userId) {
  const a = await db.prepare("SELECT * FROM etsy_accounts WHERE user_id=?").bind(userId).first();
  if (!a) return null;
  if (a.access_token_enc && Date.parse(a.access_expires_at) - Date.now() > 300e3) return { token: await unseal(env, a.access_token_enc), acct: a };
  let j;
  try { j = await tokenCall({ grant_type: "refresh_token", client_id: env.ETSY_API_KEY, refresh_token: await unseal(env, a.refresh_token_enc) }); }
  catch (e) {
    if (e.code === "invalid_grant") { await db.prepare("DELETE FROM etsy_accounts WHERE user_id=?").bind(userId).run(); return null; }
    throw e;
  }
  await db.prepare("UPDATE etsy_accounts SET access_token_enc=?, access_expires_at=?, refresh_token_enc=?, updated_at=? WHERE user_id=?")
    .bind(await seal(env, j.access_token), new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString(),
          await seal(env, j.refresh_token || await unseal(env, a.refresh_token_enc)), now(), userId).run();
  return { token: j.access_token, acct: a };
}

let _tax = { at: 0, flat: null };
export async function taxonomy(env) {
  if (_tax.flat && Date.now() - _tax.at < 86400e3) return _tax.flat;
  const r = await call(env, null, "GET", "/seller-taxonomy/nodes");
  if (!r.ok) throw new Error(etsyErrorText(r.json, r.status));
  _tax = { at: Date.now(), flat: flattenTaxonomy(r.json.results) };
  return _tax.flat;
}
export function _resetCaches() { _tax = { at: 0, flat: null }; }

/** The shop's "ready to ship in 1-3 days" processing profile id: theirs if they have one, else made. */
export async function readinessId(env, db, t) {
  if (t.acct.readiness_state_id) return t.acct.readiness_state_id;
  const shop = t.acct.shop_id;
  const list = await call(env, t.token, "GET", `/shops/${shop}/readiness-state-definitions?limit=100`);
  let id = list.ok ? ((list.json.results || []).find(r => r.readiness_state === "ready_to_ship") || {}).readiness_state_id : null;
  if (!id) {
    const r = await call(env, t.token, "POST", `/shops/${shop}/readiness-state-definitions`,
      { readiness_state: "ready_to_ship", min_processing_time: "1", max_processing_time: "3", processing_time_unit: "days" });
    if (r.ok) id = r.json.readiness_state_id;
    else if (r.status === 409) {
      // It exists already: the Content-Location header points at it.
      const loc = (r.headers && r.headers.get && r.headers.get("content-location")) || "";
      id = (loc.match(/readiness-state-definitions\/(\d+)/) || [])[1] || null;
    }
    if (!id) throw new Error(etsyErrorText(r.json, r.status));
  }
  await db.prepare("UPDATE etsy_accounts SET readiness_state_id=? WHERE user_id=?").bind(String(id), t.acct.user_id).run();
  return String(id);
}

const lastListing = (db, itemId) => db.prepare("SELECT * FROM etsy_listings WHERE item_id=? ORDER BY created_at DESC LIMIT 1").bind(itemId).first();
const listingOut = l => l ? { status: l.status, url: l.listing_url, error: l.error, price_cents: l.price_cents } : null;

/**
 * Everything the item screen needs to offer Etsy: connected?, vintage?, the era, category
 * suggestions, the shop's shipping profiles, and any listing already made.
 */
export async function plan(env, db, userId, { item, result }) {
  if (!etsyReady(env)) return { configured: false };
  const listing = listingOut(await lastListing(db, item.id));
  const t = await userToken(env, db, userId).catch(() => null);
  const base = { configured: true, connected: !!t, shop_name: t?.acct.shop_name || null, listing, notice: NOTICE };
  if (!t || (listing && ["active", "publishing", "sold"].includes(listing.status))) return base;
  const ident = result?.identification || {};
  const era = whenMadeFor(ident.period);
  let suggestions = [];
  try { suggestions = matchTaxonomy(await taxonomy(env), { category: ident.category, name: ident.name }); } catch (e) { base.taxonomy_error = String(e.message || e); }
  const sp = await call(env, t.token, "GET", `/shops/${t.acct.shop_id}/shipping-profiles`);
  const profiles = sp.ok ? (sp.json.results || []).filter(p => !p.is_deleted).map(p => ({ id: String(p.shipping_profile_id), title: p.title })) : [];
  return { ...base, period: ident.period || null, vintage: era.vintage, when_made: era.when_made, why: era.why || null,
           when_made_choices: vintageChoices(), categories: suggestions, shipping_profiles: profiles, shipping_help: SHIPPING_HELP,
           title: etsyTitle(item.ai_title || ident.name || item.name), description: item.ai_description || result?.listing?.description || "",
           price_cents: item.price_cents || null };
}

async function uploadImages(env, token, shop, listingId, photos, bucket) {
  let n = 0;
  const ok = (photos || []).filter(p => /^image\/(jpe?g|png|gif)$/i.test(p.content_type || "image/jpeg"));
  const ordered = [...ok.filter(p => p.kind === "front"), ...ok.filter(p => p.kind !== "front")].slice(0, 10);
  for (const p of ordered) {
    const obj = await bucket.get(p.r2_key);
    if (!obj) continue;
    const fd = new FormData();
    fd.append("image", new Blob([await obj.arrayBuffer()], { type: p.content_type || "image/jpeg" }), p.r2_key.split("/").pop());
    fd.append("rank", String(n + 1));
    const r = await call(env, token, "POST", `/shops/${shop}/listings/${listingId}/images`, fd);
    if (!r.ok) throw new Error(etsyErrorText(r.json, r.status));
    n++;
  }
  return n;
}

/**
 * List the item on the seller's Etsy shop: draft -> photos -> active. `credits` is what it costs
 * in estimate credits (the eBay rule); `billing` is { consume, refund } from billing.js.
 * Returns { status, body } for the route to send.
 */
export async function publish(env, db, userId, { item, photos, result }, b, credits, billing) {
  const title = etsyTitle(b.title);
  const price = Math.round(Number(b.price) * 100) / 100;
  const description = String(b.description || "").trim();
  if (!title) return { status: 400, body: { error: "Give the listing a title" } };
  if (!(price >= 0.2)) return { status: 400, body: { error: "Etsy needs a price of at least $0.20" } };
  if (!description) return { status: 400, body: { error: "Add a description" } };
  if (!vintageChoices().includes(b.when_made)) return { status: 400, body: { error: "Pick when it was made — Etsy only takes vintage (20+ years old) from resellers." } };
  if (!(Number(b.taxonomy_id) > 0)) return { status: 400, body: { error: "Pick an Etsy category" } };
  if (!b.shipping_profile_id) return { status: 400, body: { error: "Pick a shipping profile (make one in Etsy Shop Manager first)", shipping_help: SHIPPING_HELP } };
  const t = await userToken(env, db, userId);
  if (!t) return { status: 409, body: { error: "Connect your Etsy shop first", needs_connect: true } };
  const last = await lastListing(db, item.id);
  if (last?.status === "active") return { status: 409, body: { error: "Already on Etsy", url: last.listing_url, already: true } };
  if (last?.status === "publishing" && Date.now() - Date.parse(last.updated_at) < 120e3) return { status: 409, body: { error: "Already sending this one to Etsy — give it a moment." } };
  if (item.listing_status === "sold") return { status: 409, body: { error: "This item already sold." } };

  const id = crypto.randomUUID(), ts = now();
  await db.prepare("INSERT INTO etsy_listings (id,item_id,user_id,status,price_cents,taxonomy_id,when_made,created_at,updated_at) VALUES (?,?,?,'publishing',?,?,?,?,?)")
    .bind(id, item.id, userId, Math.round(price * 100), Number(b.taxonomy_id), b.when_made, ts, ts).run();
  let fundedBy = null;
  if (credits) {
    fundedBy = await billing.consume(db, userId);
    if (!fundedBy) {
      await db.prepare("DELETE FROM etsy_listings WHERE id=?").bind(id).run();
      return { status: 402, body: { error: "Listing on Etsy uses a credit, and you're out", paywall: true } };
    }
  }
  const shop = t.acct.shop_id;
  let listingId = null;
  try {
    const readiness = await readinessId(env, db, t);
    const d = await call(env, t.token, "POST", `/shops/${shop}/listings`, {
      quantity: "1", title, description, price: price.toFixed(2), who_made: "someone_else", when_made: b.when_made,
      taxonomy_id: String(Number(b.taxonomy_id)), is_supply: "false", type: "physical", should_auto_renew: "false",
      shipping_profile_id: String(b.shipping_profile_id), readiness_state_id: String(readiness) });
    if (!d.ok) throw new Error(etsyErrorText(d.json, d.status));
    listingId = String(d.json.listing_id);
    if (!(await uploadImages(env, t.token, shop, listingId, photos, env.PHOTOS))) throw new Error("Etsy needs a JPEG, PNG or GIF photo of the item");
    const a = await call(env, t.token, "PATCH", `/shops/${shop}/listings/${listingId}`, { json: { state: "active" } });
    if (!a.ok) throw new Error(etsyErrorText(a.json, a.status));
    const url = a.json.url || d.json.url || `https://www.etsy.com/listing/${listingId}`;
    await db.prepare("UPDATE etsy_listings SET status='active', listing_id=?, listing_url=?, funded_by=?, error=NULL, checked_at=?, updated_at=? WHERE id=?")
      .bind(listingId, url, fundedBy, now(), now(), id).run();
    return { status: 200, body: { status: "active", url, listing_id: listingId, credits_used: fundedBy ? 1 : 0 } };
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 500);
    // A half-made draft is free on Etsy but clutters their Shop Manager: remove it.
    if (listingId) await call(env, t.token, "DELETE", `/listings/${listingId}`).catch(() => {});
    if (fundedBy) await billing.refund(db, userId, fundedBy, `etsy listing failed: ${msg.slice(0, 250)}`);
    await db.prepare("UPDATE etsy_listings SET status='error', error=?, updated_at=? WHERE id=?").bind(msg, now(), id).run();
    return { status: 502, body: { error: msg, refunded: !!fundedBy } };
  }
}

/**
 * The item sold somewhere else: take the Etsy copy down (state inactive) so it cannot sell
 * twice. Never throws; returns { ended, why }.
 */
export async function endEtsyListing(env, db, itemId, reason = "sold elsewhere") {
  const l = await db.prepare("SELECT * FROM etsy_listings WHERE item_id=? AND status='active' ORDER BY created_at DESC LIMIT 1").bind(itemId).first();
  if (!l) return { ended: false, why: "not on Etsy" };
  try {
    if (!etsyReady(env)) throw new Error("Etsy is not configured");
    const t = await userToken(env, db, l.user_id);
    if (!t) throw new Error("Etsy is not connected");
    const r = await call(env, t.token, "PATCH", `/shops/${t.acct.shop_id}/listings/${l.listing_id}`, { json: { state: "inactive" } });
    // Already sold out / removed on Etsy is off Etsy, which is the goal.
    if (!r.ok && !(r.status === 404 || /sold|removed|expired|inactive/i.test(JSON.stringify(r.json || {})))) throw new Error(etsyErrorText(r.json, r.status));
    await db.prepare("UPDATE etsy_listings SET status='ended', error=?, updated_at=? WHERE id=?").bind(`ended: ${reason}`.slice(0, 200), now(), l.id).run();
    return { ended: true, url: l.listing_url };
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 300);
    await db.prepare("UPDATE etsy_listings SET error=?, updated_at=? WHERE id=?").bind(`could not end on Etsy: ${msg}`, now(), l.id).run();
    return { ended: false, why: msg, url: l.listing_url };
  }
}

/**
 * Cron: look at live Etsy listings (least recently checked first, each at most every 10
 * minutes). Sold out on Etsy -> the item is sold: mark it, end the eBay copy, email the seller.
 * Taken down on Etsy by the seller -> just record it.
 */
export async function pollSold(env, db, origin, { limit = 20, nowMs = Date.now() } = {}) {
  if (!etsyReady(env)) return [];
  const cutoff = new Date(nowMs - 10 * 60e3).toISOString();
  const { results } = await db.prepare("SELECT * FROM etsy_listings WHERE status='active' AND (checked_at IS NULL OR checked_at < ?) ORDER BY checked_at LIMIT ?").bind(cutoff, limit).all();
  const out = [];
  for (const l of results) {
    const ts = new Date(nowMs).toISOString();
    try {
      const t = await userToken(env, db, l.user_id);
      const r = await call(env, t ? t.token : null, "GET", `/listings/${l.listing_id}`);
      const state = r.ok ? r.json.state : (r.status === 404 ? "removed" : null);
      if (!state) throw new Error(etsyErrorText(r.json, r.status));
      if (state === "active") { await db.prepare("UPDATE etsy_listings SET checked_at=? WHERE id=?").bind(ts, l.id).run(); continue; }
      if (state === "sold_out") {
        await db.batch([
          db.prepare("UPDATE etsy_listings SET status='sold', checked_at=?, updated_at=? WHERE id=?").bind(ts, ts, l.id),
          db.prepare("UPDATE items SET listing_status='sold' WHERE id=?").bind(l.item_id),
          db.prepare("UPDATE garage_sale_items SET status='sold' WHERE item_id=? AND status IN ('available','held','pending')").bind(l.item_id),
        ]);
        const eb = await endEbayListing(env, db, l.item_id, "sold on Etsy");
        await soldEmail(env, db, l, eb, origin).catch(e => console.log("etsy sold email", String(e.message || e)));
        out.push({ id: l.id, sold: true, ebay_ended: !!eb.ended });
      } else {
        await db.prepare("UPDATE etsy_listings SET status='ended', error=?, checked_at=?, updated_at=? WHERE id=?").bind(`taken down on Etsy (${state})`, ts, ts, l.id).run();
        out.push({ id: l.id, sold: false, state });
      }
    } catch (e) {
      await db.prepare("UPDATE etsy_listings SET checked_at=?, error=? WHERE id=?").bind(ts, String(e.message || e).slice(0, 300), l.id).run();
      out.push({ id: l.id, error: String(e.message || e) });
    }
  }
  return out;
}

async function soldEmail(env, db, l, eb, origin) {
  const u = await db.prepare("SELECT email FROM users WHERE id=?").bind(l.user_id).first();
  const it = await db.prepare("SELECT ai_title, name FROM items WHERE id=?").bind(l.item_id).first();
  if (!u?.email) return;
  const name = it?.ai_title || it?.name || "an item";
  const ebayLine = eb.ended ? "We took it off eBay so it can't sell twice."
    : eb.why && eb.why !== "not on eBay" ? `We could NOT take it off eBay (${eb.why}). End the eBay listing yourself now so it can't sell twice.` : "";
  await sendAlert(env, { to: u.email, subject: `Sold on Etsy: ${name}`,
    text: `Your ${name} sold on Etsy.\n\n${ebayLine}\n\nShip it from Etsy: https://www.etsy.com/your/orders/sold\n\nYour items: ${origin}/\n\n${NOTICE}` });
}

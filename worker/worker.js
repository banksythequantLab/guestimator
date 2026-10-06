// Guestimator — API worker: accounts, items, photos (R2), AI estimates (Nebius), and listing on the
// user's own eBay account. Runs first for /api/* and /p/* (photos); everything else is static assets.
// Split from Bottle Tree (bottletree-appraiser) on 2026-09-27; the POS lives on there.
import { planFor, consumeEstimate, refundEstimate, applyRevenueCatEvent, redeemPromo, parsePromoCodes } from "./billing.js";
// New Guestimator accounts start with nothing: every estimate is bought. Accounts that already
// exist (including Bottle Tree ones signing in here) keep whatever balance they have.
// CHANGED 2026-10-05: new accounts now get a few free estimates so trying it costs nothing and
// using it becomes a habit before anyone pays (Derek: "3 to 5 ... if they don't like it they
// wouldn't have spent money"). SIGNUP_CREDITS overrides; 0 restores pay-from-the-start.
// The 30-second demo Short shown on the sign-up screen. Only an https YouTube link is passed through.
const demoVideo = env => { const u = String(env.DEMO_VIDEO_URL || ""); return /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(u) ? u : null; };
const signupCredits = env => { const n = Number(env.SIGNUP_CREDITS ?? 5); return Number.isFinite(n) && n >= 0 ? Math.min(20, Math.floor(n)) : 5; };   // 5 (2026-10-05): price + list 2 items, price a 3rd
// A free estimate for rating how close one was; capped per calendar month.
const ratingCredits = env => { const n = Number(env.RATING_CREDITS_PER_MONTH ?? 5); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5; };
// The ledger accounts for the opening balance too.
async function grantSignup(env, db, userId, ts) {
  const n = signupCredits(env);
  if (n > 0) await db.prepare("INSERT INTO billing_events (id,user_id,source,type,credits_delta,raw_json,created_at) VALUES (?,?,'admin','signup_free',?,?,?)")
    .bind(crypto.randomUUID(), userId, n, JSON.stringify({ reason: "free estimates for new accounts" }), ts).run();
}
import { appraise, sizeOnly, writeListingCopy } from "./appraiser.js";
import * as ebay from "./ebay.js";
import * as garage from "./garage.js";
import { quoteShipping } from "./shipping.js";
import * as ebayOrders from "./ebayorders.js";
import { ebaySoldAlert, buyerShippedEmail, sendAlert } from "./notify.js";
import * as labels from "./labels.js";
import * as nudges from "./nudges.js";
import * as profit from "./profit.js";
import { priceCheck } from "./pricecheck.js";
import * as weekly from "./weekly.js";
import { packageFor, flatRateFits } from "./packing.js";
import * as stickers from "./stickers.js";
import * as watchers from "./watchers.js";
import * as tax from "./tax.js";
import * as shippoauth from "./shippoauth.js";
import * as labelpay from "./labelpay.js";
import * as shipops from "./shipops.js";
import * as owner from "./owner.js";
import * as share from "./share.js";
import * as market from "./market.js";
import * as ebaycare from "./ebaycare.js";
import * as onboard from "./onboard.js";
import * as growth from "./growth.js";
import * as priceguide from "./priceguide.js";
import * as etsy from "./etsy.js";
import * as site from "./site.js";

// The Shippo account that paid for a label: the seller's own (OAuth) or the house token.
const shipEnvFor = (env, db) => async l => l.payer === "seller" ? ((await shippoauth.labelEnv(env, db, l.user_id, false)) || {}).env || null : (env.SHIPPO_API_TOKEN ? env : null);
// Every Guestimator item lives in one hidden per-user `sales` row (the schema is Bottle Tree's).
const GUESS_BUCKET = "Guestimator";
// The Android app's URL scheme (strings.xml custom_url_scheme; AndroidManifest intent-filter).
const APP_SCHEME = "ai.banksy.bottletree";
// What listing one item on eBay costs, in estimate credits. EBAY_LISTING_CREDITS may be 0 (free)
// or 1; anything else is read as 1 until the ledger can take more than one credit at a time.
const listingCredits = env => (String(env.EBAY_LISTING_CREDITS ?? "1").trim() === "0" ? 0 : 1);
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const enc = new TextEncoder();
function J(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders } });
}
function H(html, status = 200, cache = "public, max-age=60") {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache } });
}
async function readJson(req) { try { return await req.json(); } catch { return {}; } }
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""); }
function randHex(n = 32) { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); }
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const money = c => "$" + (Number(c || 0) / 100).toFixed(2);
const PHOTO_KINDS = new Set(["front", "back", "underside", "marks", "detail", "damage", "other"]);
const slugify = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

async function pbkdf2(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return hex(bits);
}
function timingEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

function getCookie(req, name) {
  const c = req.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
// ---- Google ID token verification (RS256 against Google's JWKS) ----
const b64urlToBytes = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));
let _jwks = { keys: [], at: 0 };
async function googleKeys() {
  if (Date.now() - _jwks.at < 3600e3 && _jwks.keys.length) return _jwks.keys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!r.ok) throw new Error("jwks fetch failed");
  _jwks = { keys: (await r.json()).keys || [], at: Date.now() };
  return _jwks.keys;
}
/** Returns { sub, email, email_verified, name } or throws. Verifies signature, issuer, audience and expiry. */
async function verifyGoogleIdToken(idToken, clientId) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  if (header.alg !== "RS256") throw new Error("unexpected alg");
  const jwk = (await googleKeys()).find(k => k.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) throw new Error("bad signature");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) throw new Error("bad issuer");
  if (!clientId || claims.aud !== clientId) throw new Error("bad audience");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) throw new Error("token expired");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new Error("email not verified");
  if (!claims.email) throw new Error("no email in token");
  return { sub: claims.sub, email: String(claims.email).trim().toLowerCase(), name: claims.name || "" };
}
function sessionCookie(token) { return `bt_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`; }
const clearCookie = "bt_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

async function currentUser(req, db) {
  const tok = getCookie(req, "bt_session");
  if (!tok) return null;
  const s = await db.prepare("SELECT user_id, expires_at FROM sessions WHERE token=?").bind(tok).first();
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) { await db.prepare("DELETE FROM sessions WHERE token=?").bind(tok).run(); return null; }
  return s.user_id;
}
async function newSession(db, userId) {
  const tok = randHex(24);
  const exp = new Date(Date.now() + 2592000000).toISOString();
  await db.prepare("INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)").bind(tok, userId, now(), exp).run();
  return tok;
}

// ---------- appraisal ----------
// Runs inside the Worker: appraiser.js talks to Nebius Token Factory and Tavily directly. It used to
// POST to a FastAPI container, which meant something had to be hosted and awake; nothing does now.
// Set APPRAISER_URL to fall back to that container (the offline kiosk still runs it).
async function runAppraisal(env, appraisalId, item, photos) {
  const db = env.DB;
  try {
    const body = {
      item_id: item.id,
      description: item.description || "",
      markings: item.markings || "",
      currency: "USD",
      photos: photos.map(p => ({ url: `${env.PUBLIC_ORIGIN}/p/${p.r2_key}`, kind: p.kind })),
      // How many earlier runs on this item finished. A second unsure run is marked unknown
      // instead of asking more questions (isUnknown / shouldGate in appraiser.js).
      prior_tries: (await db.prepare("SELECT COUNT(*) AS n FROM appraisals WHERE item_id=? AND id<>? AND status='done'")
        .bind(item.id, appraisalId).first().catch(() => null))?.n || 0,
    };
    let result, text;
    if (env.APPRAISER_URL) {
      const headers = { "content-type": "application/json" };
      if (env.APPRAISER_SERVICE_KEY) headers["x-appraiser-key"] = env.APPRAISER_SERVICE_KEY;
      if (env.APPRAISER_TOKEN) headers["authorization"] = `Bearer ${env.APPRAISER_TOKEN}`;
      const r = await fetch(`${env.APPRAISER_URL}/appraise`, { method: "POST", headers, body: JSON.stringify(body) });
      text = await r.text();
      if (!r.ok) throw new Error(`appraiser ${r.status}: ${text.slice(0, 300)}`);
      result = JSON.parse(text);
    } else {
      result = await appraise(env, body);
      text = JSON.stringify(result);
    }
    await db.prepare("UPDATE appraisals SET status='done', result_json=?, model_text=?, model_vision=?, completed_at=? WHERE id=?")
      .bind(text, result.models?.text || null, result.models?.vision || null, now(), appraisalId).run();
    // pre-fill AI copy on the item (dealer still approves before it goes live)
    await db.prepare("UPDATE items SET ai_title=?, ai_description=? WHERE id=?")
      .bind(result.listing?.title || null, result.listing?.description || null, item.id).run();
    // The price is saved and showing; now the listing text (no longer part of the estimate call).
    if (!result.listing?.description) await ensureListingCopy(env, db, appraisalId, item, result);
  } catch (e) {
    await db.prepare("UPDATE appraisals SET status='error', error=?, completed_at=? WHERE id=?")
      .bind(String(e && e.message || e).slice(0, 1000), now(), appraisalId).run();
    // a failed run must not cost the dealer an estimate
    const ap = await db.prepare("SELECT funded_by FROM appraisals WHERE id=?").bind(appraisalId).first();
    const owner = await db.prepare("SELECT s.user_id FROM items i JOIN sales s ON s.id=i.sale_id WHERE i.id=?").bind(item.id).first();
    // The reason is kept verbatim in the ledger. "appraisal failed" for everything made the
    // unreadable-photo refusals indistinguishable from a model outage when reconciling later.
    if (ap?.funded_by && owner?.user_id)
      await refundEstimate(db, owner.user_id, ap.funded_by, String(e && e.message || e).slice(0, 300));
  }
}

// Writes the listing title and shop text for a finished estimate and stores them on both the
// appraisal and the item. Never throws: an estimate without listing text is still an estimate.
async function ensureListingCopy(env, db, appraisalId, item, result) {
  try {
    const copy = await writeListingCopy(env, result, item);
    if (!copy) return result;
    result.listing = { ...(result.listing || {}), ...copy };
    await db.batch([
      db.prepare("UPDATE appraisals SET result_json=? WHERE id=?").bind(JSON.stringify(result), appraisalId),
      // Only fill what the seller hasn't already written.
      db.prepare("UPDATE items SET ai_title=COALESCE(NULLIF(ai_title,''),?), ai_description=COALESCE(NULLIF(ai_description,''),?) WHERE id=?")
        .bind(copy.title, copy.description, item.id),
    ]);
  } catch (e) { console.log("listing copy failed", String(e && e.message || e)); }
  return result;
}

// A database hiccup worth one retry, as opposed to a real error.
const transientD1 = e => /network connection lost|connection (was )?reset|D1_ERROR:.*(timeout|timed out|internal error|overloaded)|storage operation exceeded/i.test(String(e && e.message || e));

async function itemBundle(db, itemId) {
  const item = await db.prepare("SELECT * FROM items WHERE id=?").bind(itemId).first();
  if (!item) return null;
  const photos = (await db.prepare("SELECT * FROM photos WHERE item_id=? ORDER BY sort, created_at").bind(itemId).all()).results;
  const ap = await db.prepare("SELECT * FROM appraisals WHERE item_id=? ORDER BY created_at DESC LIMIT 1").bind(itemId).first();
  let appraisal = null;
  if (ap) appraisal = { id: ap.id, status: ap.status, error: ap.error, created_at: ap.created_at, completed_at: ap.completed_at,
                        result: ap.result_json ? JSON.parse(ap.result_json) : null };
  // Estimates made before the two-tries rule (2026-10-05) still carry their questions; apply the
  // rule when they are read, so an item already in a question loop opens as "unknown" instead.
  const res0 = appraisal?.result;
  if (res0 && appraisal.status === "done" && !res0.unknown && !res0.accepted_uncertain && res0.needs_clarification) {
    const tries = (await db.prepare("SELECT COUNT(*) AS n FROM appraisals WHERE item_id=? AND status='done'").bind(itemId).first())?.n || 0;
    const conf = Number(res0.confidence ?? 0.5);
    if (tries >= 2 && (conf < 0.7 || res0.needs_clarification.candidates)) {
      res0.unknown = { tries, confidence: conf, reason: res0.needs_clarification.candidates
        ? "the photographs and your description still point to different things"
        : "the photographs and details aren't enough to say exactly what this is" };
      res0.needs_clarification = null;
    }
  }
  if (appraisal) appraisal.rating = (await db.prepare("SELECT stars, credited FROM estimate_ratings WHERE appraisal_id=?").bind(appraisal.id).first()) || null;
  const el = await db.prepare("SELECT id, status, listing_url, listing_id, error, updated_at, price_cents, best_offer_accept_cents, best_offer_decline_cents FROM ebay_listings WHERE item_id=? ORDER BY created_at DESC LIMIT 1").bind(itemId).first();
  const fin = await db.prepare("SELECT cost_cents, note, sold_cents, sold_at FROM item_finance WHERE item_id=?").bind(itemId).first();
  return { item, photos: photos.map(p => ({ ...p, url: `/p/${p.r2_key}` })), appraisal, ebay: el || null, finance: fin || null };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const db = env.DB;
    const parts = p.split("/").filter(Boolean);
    const m = request.method;
    try {
      // ---------- which site: Instant Garage Sale's own domain serves its own front page ----------
      // ("/" and the manifest run through the Worker for this; on Guestimator they pass straight
      // to the static files as before.)
      if (m === "GET" && (p === "/" || p === "/index.html" || p === "/manifest.webmanifest")) {
        if (site.isIgs(env, url)) {
          const r = await env.ASSETS.fetch(new Request(url.origin + (p === "/manifest.webmanifest" ? "/igs/manifest.webmanifest" : "/igs/"), request));
          return new Response(r.body, { status: r.status, headers: r.headers });
        }
        return env.ASSETS.fetch(request);
      }
      // ---------- PUBLIC: photos from R2 ----------
      if (parts[0] === "p" && parts.length >= 2 && m === "GET") {
        const obj = await env.PHOTOS.get(parts.slice(1).join("/"));
        if (!obj) return new Response("not found", { status: 404 });
        return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType || "image/jpeg", "cache-control": "public, max-age=31536000, immutable", etag: obj.httpEtag } });
      }
      // ---------- PUBLIC: a shared estimate (share.js) ----------
      if (parts[0] === "e" && parts.length === 2 && m === "GET") {
        const html = await share.sharePage(db, parts[1], env.PUBLIC_ORIGIN || url.origin);
        return html ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } })
          : new Response("This link isn't available any more.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      // ---------- PUBLIC: garage / estate sale pages ----------
      if (parts[0] === "market" && parts.length === 1 && m === "GET") return await market.marketPage(env, url);
      if (parts[0] === "sale" && parts[1] && m === "GET")
        return await garage.salePages(request, env, url, parts, await currentUser(request, db));
      // ---------- Shippo OAuth callback: a seller connected their own Shippo account ----------
      if (parts[0] === "shippo" && parts[1] === "callback" && m === "GET") {
        const origin = env.PUBLIC_ORIGIN || url.origin;
        const who = await shippoauth.readState(env, url.searchParams.get("state"));
        if (!who || !url.searchParams.get("code") || !shippoauth.oauthReady(env)) return Response.redirect(origin + "/?shippo=failed#ebay-orders", 302);
        try { await shippoauth.saveToken(env, db, who, await shippoauth.exchange(env, url.searchParams.get("code"))); }
        catch (e) { await owner.opsFail(db, "shippo oauth failed", e); console.log("shippo oauth failed", String(e.message || e)); return Response.redirect(origin + "/?shippo=failed#ebay-orders", 302); }
        return Response.redirect(origin + "/?shippo=connected#ebay-orders", 302);
      }
      // ---------- Etsy OAuth callback (PKCE): a seller connected their Etsy shop ----------
      if (parts[0] === "etsy" && parts[1] === "callback" && m === "GET") {
        const state = url.searchParams.get("state") || "";
        const native = state.startsWith("n");
        const back = ok => native ? `${APP_SCHEME}://etsy/${ok ? "connected" : "failed"}` : (ok ? "/?etsy=connected" : "/?etsy=failed");
        const fail = msg => H(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Etsy was not connected</title>
<body style="font-family:system-ui,sans-serif;background:#F4ECDC;color:#241B10;padding:24px"><h1 style="font-size:1.3rem;color:#B4552B">Etsy was not connected</h1><p>${esc(msg)}</p>
<a href="${esc(back(false))}" style="display:inline-block;background:#0F6B59;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700">Back to Guestimator</a>
<p style="font-size:.75rem;color:#6b5d48;margin-top:24px">${esc(etsy.NOTICE)}</p></body>`, 400, "no-store");
        const st = state ? await db.prepare("SELECT * FROM etsy_oauth_states WHERE state=?").bind(state).first() : null;
        if (st) await db.prepare("DELETE FROM etsy_oauth_states WHERE state=?").bind(state).run();
        if (!st || Date.now() - Date.parse(st.created_at) > 15 * 60e3) return fail("That link has expired. Go back to Guestimator and tap Connect Etsy again.");
        const code = url.searchParams.get("code");
        if (!code) return fail("You declined on Etsy, so nothing was linked. You can connect any time.");
        try { await etsy.saveConnection(env, db, st.user_id, await etsy.exchangeCode(env, code, st.verifier)); }
        catch (e) { await owner.opsFail(db, "etsy oauth failed", e); return fail(String(e.message || e)); }
        return new Response(null, { status: 302, headers: { location: back(true), "cache-control": "no-store" } });
      }
      // ---------- public price guide, sitemap and robots (priceguide.js) ----------
      if (m === "GET" && (url.pathname === "/prices" || url.pathname.startsWith("/price/") || url.pathname === "/sitemap.xml" || url.pathname === "/robots.txt")) {
        const origin = env.PUBLIC_ORIGIN || url.origin, pub = { "cache-control": "public, max-age=3600" };
        if (url.pathname === "/robots.txt") return new Response(priceguide.robots(origin), { headers: { "content-type": "text/plain; charset=utf-8", ...pub } });
        if (url.pathname === "/sitemap.xml") return new Response(priceguide.sitemap(await priceguide.allGuides(db), origin, await market.sitemapEntries(env, db).catch(() => [])), { headers: { "content-type": "application/xml; charset=utf-8", ...pub } });
        if (url.pathname === "/prices") return new Response(priceguide.indexPage(await priceguide.allGuides(db), origin), { headers: { "content-type": "text/html; charset=utf-8", ...pub } });
        const idm = url.pathname.match(/^\/price\/(?:[a-z0-9-]*-)?(\d{6,20})\/?$/);
        const g = idm && await priceguide.guideById(db, idm[1]);
        if (!g) return new Response(`<!doctype html><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width"><p style="font-family:system-ui;padding:24px">That price page isn't here. <a href="/prices">See the price guide</a>.</p>`, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
        if (url.pathname !== priceguide.pagePath(g)) return Response.redirect(origin + priceguide.pagePath(g), 301);
        return new Response(priceguide.guidePage(g, origin), { headers: { "content-type": "text/html; charset=utf-8", ...pub } });
      }
      // ---------- share target without the service worker (first visit, or SW not installed yet):
      // the photos can't be kept, so just open the app rather than showing an error ----------
      if (parts[0] === "share-target" && parts.length === 1 && m === "POST") return Response.redirect((env.PUBLIC_ORIGIN || url.origin) + "/?shared=0", 303);
      // ---------- owner dashboard (owner only; everyone else gets a 404) ----------
      if (parts[0] === "owner" && parts.length === 1 && m === "GET") {
        const uidO = await currentUser(request, db);
        const meO = uidO ? await db.prepare("SELECT email FROM users WHERE id=?").bind(uidO).first() : null;
        if (!meO || !owner.isOwner(env, meO.email)) return new Response("Not found", { status: 404 });
        return new Response(owner.ownerPage(await owner.ownerStats(db, env)),
          { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
      }
      // One-time win-back from the owner page: free estimates + one email to the people ticked there.
      // x-gs-owner: a cross-site form can't set a custom header, so this can only come from the page.
      if (parts[0] === "owner" && parts[1] === "winback" && parts.length === 2 && m === "POST") {
        const uidW = await currentUser(request, db);
        const meW = uidW ? await db.prepare("SELECT email FROM users WHERE id=?").bind(uidW).first() : null;
        if (!meW || !owner.isOwner(env, meW.email) || request.headers.get("x-gs-owner") !== "1") return J({ error: "not found" }, 404);
        const b = await readJson(request);
        const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 100) : [];
        if (!ids.length) return J({ error: "nobody ticked" }, 400);
        return J(await growth.winbackFree(env, db, env.PUBLIC_ORIGIN || url.origin, meW.email, { only: ids }));
      }
      // Resend the win-back email to people who got the credits but whose email was refused.
      if (parts[0] === "owner" && parts[1] === "winback-resend" && parts.length === 2 && m === "POST") {
        const uidR = await currentUser(request, db);
        const meR = uidR ? await db.prepare("SELECT email FROM users WHERE id=?").bind(uidR).first() : null;
        if (!meR || !owner.isOwner(env, meR.email) || request.headers.get("x-gs-owner") !== "1") return J({ error: "not found" }, 404);
        const b = await readJson(request);
        const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 100) : [];
        if (!ids.length) return J({ error: "nobody ticked" }, 400);
        return J(await growth.winbackResend(env, db, env.PUBLIC_ORIGIN || url.origin, ids));
      }
      // Owner-only: send one test email and return exactly what the mail service said.
      if (parts[0] === "owner" && parts[1] === "mailtest" && parts.length === 2 && m === "POST") {
        const uidM = await currentUser(request, db);
        const meM = uidM ? await db.prepare("SELECT email FROM users WHERE id=?").bind(uidM).first() : null;
        if (!meM || !owner.isOwner(env, meM.email) || request.headers.get("x-gs-owner") !== "1") return J({ error: "not found" }, 404);
        const b = await readJson(request);
        const to = String(b.to || "").trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return J({ error: "bad address" }, 400);
        return J(await sendAlert(env, { to, subject: "Guestimator mail test", text: "Test from the owner page. If you got this, mail to this address works." }));
      }
      // ---------- tax-time summary (signed-in seller only; printable page) ----------
      if (parts[0] === "tax-summary" && parts.length === 1 && m === "GET") {
        const uidT = await currentUser(request, db);
        if (!uidT) return Response.redirect((env.PUBLIC_ORIGIN || url.origin) + "/", 302);
        const yr = Math.min(2100, Math.max(2000, Number(url.searchParams.get("year")) || new Date().getUTCFullYear()));
        const me = await db.prepare("SELECT email FROM users WHERE id=?").bind(uidT).first();
        return new Response(tax.taxPage(await tax.taxSummary(db, uidT, yr), me?.email || ""),
          { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }      // ---------- inventory stickers (signed-in seller only; printable page) ----------
      if (parts[0] === "stickers" && parts.length === 1 && m === "GET") {
        const uidS = await currentUser(request, db);
        if (!uidS) return Response.redirect((env.PUBLIC_ORIGIN || url.origin) + "/", 302);
        const ids = (url.searchParams.get("ids") || "").split(",").map(x => x.trim()).filter(Boolean);
        const list = await stickers.stickerItems(db, uidS, ids);
        return new Response(stickers.stickerPage(list, env.PUBLIC_ORIGIN || url.origin,
          { skip: Number(url.searchParams.get("skip")) || 0, plain: url.searchParams.get("plain") === "1" }),
          { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (!p.startsWith("/api/")) return env.ASSETS.fetch(request);
      if (parts[1] === "public" && parts[2] === "garage") return await garage.publicApi(request, env, url, parts, ctx);

      // ---------- BILLING: RevenueCat webhook (Authorization: Bearer <RC_WEBHOOK_SECRET>, set in the RC dashboard) ----------
      if (parts[1] === "billing" && parts[2] === "revenuecat" && m === "POST") {
        if (!env.RC_WEBHOOK_SECRET) return J({ error: "billing webhook not configured" }, 503);
        const auth = request.headers.get("authorization") || "";
        if (!timingEq(auth, `Bearer ${env.RC_WEBHOOK_SECRET}`)) return J({ error: "unauthorized" }, 401);
        const body = await readJson(request);
        if (!body.event) return J({ error: "no event" }, 400);
        return J(await applyRevenueCatEvent(db, body.event));
      }

      // ---------- eBay marketplace account deletion / closure notification ----------
      // eBay disables a production keyset until the developer either implements this endpoint or
      // declares they persist no eBay data. We do persist a little — up to six listing titles,
      // prices and URLs end up in a stored appraisal — so the honest route is to implement it
      // rather than sign a declaration that is arguably untrue.
      //
      // GET carries a challenge code and must be answered with
      //   sha256(challengeCode + verificationToken + endpointUrl)
      // hashed in exactly that order, hex encoded. The endpoint URL must match what is registered
      // with eBay character for character, which is why it is configuration and not derived from
      // the request — a proxy or a trailing slash would silently change the hash.
      // One-click unsubscribe from win-back reminders (growth.js): signed per user, no sign-in.
      if (parts[1] === "growth" && parts[2] === "off" && m === "GET") {
        const u = url.searchParams.get("u"), t = url.searchParams.get("t");
        const page = msg => new Response(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f4ecdc;padding:40px;color:#241b10"><div style="max-width:420px;margin:0 auto;background:#fbf6ea;border:1px solid #e0d2b4;border-radius:14px;padding:20px">${msg}</div></body>`,
          { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        if (!(await growth.offTokenOk(env, u, t))) return page("That link isn't valid.");
        await growth.turnOff(db, u);
        return page("<b>Done.</b> No more reminder emails. Sale alerts and receipts still come.");
      }
      // One-click "stop these weekly emails" from the email itself: signed per user, no sign-in.
      if (parts[1] === "weekly" && parts[2] === "off" && m === "GET") {
        const u = url.searchParams.get("u"), t = url.searchParams.get("t");
        const page = msg => new Response(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f4ecdc;padding:40px;color:#241b10"><div style="max-width:420px;margin:0 auto;background:#fbf6ea;border:1px solid #e0d2b4;border-radius:14px;padding:20px">${msg}</div></body>`,
          { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        if (!(await weekly.offTokenOk(env, u, t))) return page("That link isn't valid. Sign in to Guestimator to change your emails.");
        await weekly.turnOff(db, u);
        return page("<b>Done.</b> You won't get the weekly selling summary any more. Sale alerts still come when something sells.");
      }
      if (parts[1] === "ebay" && parts[2] === "deletion") {
        if (!env.EBAY_VERIFY_TOKEN || !env.EBAY_DELETION_URL)
          return J({ error: "deletion endpoint not configured" }, 503);
        if (m === "GET") {
          const challenge = url.searchParams.get("challenge_code");
          if (!challenge) return J({ error: "challenge_code required" }, 400);
          // eBay hashes the endpoint exactly as registered, and it calls exactly that URL - so the
          // URL of this very request (minus the query) IS the registered endpoint. Using it rather
          // than EBAY_DELETION_URL means the app domain, workers.dev, or a trailing slash can
          // never produce a hash eBay rejects. (2026-09-27: eBay refused app.theguestimator.com.)
          const endpoint = url.origin + url.pathname;
          const token = String(env.EBAY_VERIFY_TOKEN).trim();
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(challenge + token + endpoint));
          const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
          console.log("ebay deletion challenge", JSON.stringify({ endpoint, configured: env.EBAY_DELETION_URL,
            ua: request.headers.get("user-agent"), challenge_len: challenge.length }));
          return J({ challengeResponse: hex });
        }
        if (m === "POST") {
          // Guestimator DOES hold eBay user data: a linked account's sealed tokens, its eBay user
          // id and username. A closed eBay account takes all of that with it. The listings log
          // keeps its rows (they are the user's own history in this app) but nothing of eBay's.
          const body = await readJson(request).catch(() => ({}));
          const d = body?.notification?.data || {};
          let removed = 0;
          if (d.userId || d.username) {
            const r = await db.prepare("DELETE FROM ebay_accounts WHERE ebay_user_id=? OR ebay_username=?")
              .bind(d.userId || "\u0000", d.username || "\u0000").run();
            removed = r.meta?.changes || 0;
          }
          console.log("ebay account deletion notification", JSON.stringify({
            at: now(), notificationId: body?.notification?.notificationId || null, removed,
          }));
          return new Response(null, { status: 204 });
        }
        return J({ error: "method not allowed" }, 405);
      }

      // ---------- eBay OAuth callback (public: it lands in whatever browser eBay opened) ----------
      // On a phone that is Chrome, not the app, so there is no session cookie here. The single-use
      // `state` row is what ties the code to a Guestimator account, and it expires in 15 minutes.
      if (parts[1] === "ebay" && parts[2] === "callback" && m === "GET") {
        const state = url.searchParams.get("state") || "";
        // Started in the Android app? Then "back" means the app, by its URL scheme - the page is
        // showing in a Custom Tab over it. Success is a straight 302 to the scheme: it continues
        // the redirect chain from the user's tap on eBay's Agree button, which Chrome lets open an
        // app. A script redirect would not be allowed to. Failures get a page with a button, and
        // the button is a user tap, so that one may open the app too.
        const native = state.startsWith("n");
        const back = ok => native ? `${APP_SCHEME}://ebay/${ok ? "connected" : "failed"}` : (ok ? "/?ebay=connected" : "/");
        const page = (title, msg, ok) => H(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#F4ECDC;color:#241B10;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px}
.c{background:#FBF6EA;border:1px solid #E0D2B4;border-radius:14px;padding:22px;max-width:420px;text-align:center}.c h1{font-size:1.3rem;margin:0 0 8px}
.ok{color:#0F6B59}.bad{color:#B4552B}a{display:inline-block;margin-top:14px;background:#0F6B59;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700}</style></head>
<body><div class="c"><h1 class="${ok ? "ok" : "bad"}">${esc(title)}</h1><p>${esc(msg)}</p><a href="${esc(back(ok))}">Back to Guestimator</a></div></body></html>`, ok ? 200 : 400, "no-store");
        const done = () => new Response(null, { status: 302, headers: { location: back(true), "cache-control": "no-store" } });
        const st = state ? await db.prepare("SELECT * FROM ebay_oauth_states WHERE state=?").bind(state).first() : null;
        if (st) await db.prepare("DELETE FROM ebay_oauth_states WHERE state=?").bind(state).run();
        if (!st || Date.now() - Date.parse(st.created_at) > 15 * 60e3)
          return page("That link has expired", "Go back to Guestimator and tap Connect eBay again.", false);
        const code = url.searchParams.get("code");
        if (!code) return page("eBay was not connected", "You declined on eBay, so nothing was linked. You can connect any time.", false);
        try {
          const tok = await ebay.exchangeCode(env, code);
          if (!tok.refresh_token) throw new Error("eBay did not grant lasting access; try connecting again");
          const who = await ebay.identity(env, tok.access_token);
          const ts = now();
          const refreshExp = tok.refresh_token_expires_in ? new Date(Date.now() + tok.refresh_token_expires_in * 1000).toISOString() : null;
          await db.prepare(
            "INSERT INTO ebay_accounts (user_id,ebay_user_id,ebay_username,refresh_token_enc,refresh_expires_at,access_token_enc,access_expires_at,created_at,updated_at) " +
            "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET ebay_user_id=excluded.ebay_user_id, ebay_username=excluded.ebay_username, " +
            "refresh_token_enc=excluded.refresh_token_enc, refresh_expires_at=excluded.refresh_expires_at, access_token_enc=excluded.access_token_enc, " +
            "access_expires_at=excluded.access_expires_at, fulfillment_ok=NULL, updated_at=excluded.updated_at")
            .bind(st.user_id, who.userId, who.username, await ebay.seal(env, tok.refresh_token), refreshExp,
                  await ebay.seal(env, tok.access_token), new Date(Date.now() + (tok.expires_in || 7200) * 1000).toISOString(), ts, ts).run();
          return done();
        } catch (e) {
          console.log("ebay callback failed", String(e && e.message));
          return page("eBay was not connected", String(e && e.message || e), false);
        }
      }

      // ---------- AUTH ----------
      if (parts[1] === "auth") {
        const act = parts[2];
        if (act === "register" && m === "POST") {
          const b = await readJson(request);
          const email = (b.email || "").trim().toLowerCase();
          const pw = b.password || "";
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return J({ error: "Enter a valid email" }, 400);
          if (pw.length < 8) return J({ error: "Password must be at least 8 characters" }, 400);
          const exists = await db.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
          if (exists) return J({ error: "That email is already registered" }, 409);
          const salt = randHex(16), h = await pbkdf2(pw, salt), id = uid(), ts = now();
          // Opening balance: signupCredits (free estimates, since 2026-10-05; was 0 from 2026-09-27).
          // Written explicitly because users.credits defaults to Bottle Tree's 1, and recorded in
          // the ledger so it still accounts for exactly what the wallet holds.
          await db.prepare("INSERT INTO users (id,email,pw_hash,pw_salt,created_at,credits) VALUES (?,?,?,?,?,?)")
            .bind(id, email, h, salt, ts, signupCredits(env)).run();
          await grantSignup(env, db, id, ts);
          if (!site.isIgs(env, url)) ctx.waitUntil(onboard.welcomeEmail(env, email, env.PUBLIC_ORIGIN || url.origin).catch(e => console.log("welcome email", e)));
          await growth.markGsUser(db, id);
          return J({ email }, 200, { "Set-Cookie": sessionCookie(await newSession(db, id)) });
        }
        if (act === "login" && m === "POST") {
          const b = await readJson(request);
          const email = (b.email || "").trim().toLowerCase();
          const u = await db.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
          if (!u) return J({ error: "Wrong email or password" }, 401);
          // Google-only accounts carry an empty hash; never let that match a submitted password.
          if (!u.pw_hash) return J({ error: "This account uses Sign in with Google" }, 401);
          const h = await pbkdf2(b.password || "", u.pw_salt);
          if (!timingEq(h, u.pw_hash)) return J({ error: "Wrong email or password" }, 401);
          await growth.markGsUser(db, u.id);
          return J({ email }, 200, { "Set-Cookie": sessionCookie(await newSession(db, u.id)) });
        }
        if (act === "google" && m === "POST") {
          // Two ways in. The app's popup posts JSON here. /api/auth/google/redirect is Google's
          // redirect mode (used on iPhone/iPad Safari, where the popup fails with Google's "400.
          // That's an error"): Google POSTs a form with the token, and the answer is a redirect home.
          const viaRedirect = parts[3] === "redirect";
          const home = (ok, cookie) => new Response(null, { status: 303, headers: { location: ok ? "/" : "/?google=failed", "cache-control": "no-store", ...(cookie ? { "Set-Cookie": cookie } : {}) } });
          if (!env.GOOGLE_CLIENT_ID) return viaRedirect ? home(false) : J({ error: "Google sign-in is not configured" }, 503);
          let b;
          if (viaRedirect) {
            const fd = await request.formData().catch(() => null);
            b = { credential: fd?.get("credential") };
            // Google's double-submit token: the same value in a cookie and in the form. Safari may
            // not send the cookie on Google's cross-site POST; the signed ID token is still checked.
            const ck = getCookie(request, "g_csrf_token"), bodyTok = fd?.get("g_csrf_token");
            if (ck && ck !== bodyTok) return home(false);
          } else b = await readJson(request);
          let g;
          try { g = await verifyGoogleIdToken(b.credential, env.GOOGLE_CLIENT_ID); }
          catch (e) { return viaRedirect ? home(false) : J({ error: "Could not verify that Google sign-in" }, 401); }
          // Match on sub first (email can change), then fall back to email to link an existing password account.
          let u = await db.prepare("SELECT * FROM users WHERE google_sub=?").bind(g.sub).first();
          if (!u) {
            u = await db.prepare("SELECT * FROM users WHERE email=?").bind(g.email).first();
            if (u) await db.prepare("UPDATE users SET google_sub=? WHERE id=?").bind(g.sub, u.id).run();
          }
          if (!u) {
            const id = uid(), ts = now();
            // Same opening balance whichever door they came in by.
            await db.prepare("INSERT INTO users (id,email,pw_hash,pw_salt,google_sub,created_at,credits) VALUES (?,?,'','',?,?,?)")
              .bind(id, g.email, g.sub, ts, signupCredits(env)).run();
            await grantSignup(env, db, id, ts);
            u = { id, email: g.email };
            if (!site.isIgs(env, url)) ctx.waitUntil(onboard.welcomeEmail(env, g.email, env.PUBLIC_ORIGIN || url.origin).catch(e => console.log("welcome email", e)));
          }
          {
            await growth.markGsUser(db, u.id);
          }
          if (viaRedirect) return home(true, sessionCookie(await newSession(db, u.id)));
          return J({ email: u.email }, 200, { "Set-Cookie": sessionCookie(await newSession(db, u.id)) });
        }
        if (act === "logout" && m === "POST") {
          const tok = getCookie(request, "bt_session");
          if (tok) await db.prepare("DELETE FROM sessions WHERE token=?").bind(tok).run();
          return J({ ok: true }, 200, { "Set-Cookie": clearCookie });
        }
        if (act === "me" && m === "GET") {
          const uidv = await currentUser(request, db);
          if (!uidv) return J({ error: "not authenticated" }, 401);
          const u = await db.prepare("SELECT email, shop_slug, shop_name, shop_blurb FROM users WHERE id=?").bind(uidv).first();
          return J(u ? { ...u, owner: owner.isOwner(env, u.email) || undefined } : {});
        }
        // Public: the web client ID is not a secret; the app needs it to render the Google button.
        if (act === "config" && m === "GET")
          return J({ google_client_id: env.GOOGLE_CLIENT_ID || null, referral_credits: growth.refCredits(env),
                     signup_credits: signupCredits(env), rating_credits: ratingCredits(env), demo_video: demoVideo(env),
                     // On once /api/auth/google/redirect is an authorized redirect URI in Google Cloud.
                     google_redirect: String(env.GOOGLE_REDIRECT || "") === "on" });
        return J({ error: "not found" }, 404);
      }

      // ---------- everything below requires a session ----------
      const userId = await currentUser(request, db);
      if (!userId) return J({ error: "not authenticated" }, 401);
      // Etsy is only shown to allowed accounts until it works for everyone (etsy.etsyAllowed).
      const etsyOn = async () => etsy.etsyOnFor(env, (await db.prepare("SELECT email FROM users WHERE id=?").bind(userId).first())?.email);
      const ownsSale = async (sid) => !!(await db.prepare("SELECT id FROM sales WHERE id=? AND user_id=?").bind(sid, userId).first());
      const ownsItem = async (iid) => await db.prepare("SELECT i.* FROM items i JOIN sales s ON s.id=i.sale_id WHERE i.id=? AND s.user_id=?").bind(iid, userId).first();

      // ---------- garage / estate sales (free) ----------
      if (parts[1] === "garage") return await garage.sellerApi(request, env, url, parts, userId, ctx);
      // ---------- one-tap "Sell on the Market" (market.js) ----------
      if (parts[1] === "market" && parts[2] === "items" && parts[3] && parts.length === 4) return await market.sellerApi(request, env, url, parts, userId);

      // ---------- plan / credits (the app shows this on the paywall and the appraisal button) ----------
      if (parts[1] === "me" && parts[2] === "plan" && m === "GET") {
        // rc_web_link is a RevenueCat Web Purchase Link. The web paywall appends /<user_id>, and the
        // RevenueCat webhook credits that same id — the identical path a Play purchase takes.
        const me = await db.prepare("SELECT email FROM users WHERE id=?").bind(userId).first();
        // A way to pay with no way to be credited takes someone's money and gives nothing back.
        // The Road Show deployment was exactly that: RC_WEB_LINK set, RC_WEBHOOK_SECRET absent, so
        // every purchase would have 503'd at the webhook and never reached the buyer's account.
        // Fail closed — offer no purchase route unless the webhook that credits it is configured.
        // Guestimator: the webhook lives on bottletree-app (RC_WEBHOOK_ON), writing this same D1.
        const canCredit = !!(env.RC_WEBHOOK_SECRET || env.RC_WEBHOOK_ON);
        return J({
          user_id: userId, email: me?.email || null,
          rc_android_key: canCredit ? (env.RC_ANDROID_KEY || null) : null,
          rc_web_link: canCredit ? (env.RC_WEB_LINK || null) : null,
          billing_ready: canCredit,
          play_url: env.PLAY_URL || null,
          ...(await planFor(db, userId)),
        });
      }

      // ---------- promo codes (free credits, no checkout) ----------
      // ---------- referral link: mine, and claiming the one I signed up through ----------
      if (parts[1] === "referral" && parts.length === 2 && m === "GET")
        return J(await growth.referralInfo(env, db, userId, env.PUBLIC_ORIGIN || url.origin));
      if (parts[1] === "referral" && parts[2] === "claim" && m === "POST") {
        const r = await growth.claim(db, userId, (await readJson(request)).code);
        return J(r, r.status);
      }
      if (parts[1] === "me" && parts[2] === "redeem" && m === "POST") {
        const b = await readJson(request);
        const r = await redeemPromo(db, userId, b.code, parsePromoCodes(env.PROMO_CODES));
        return r.ok ? J(r) : J({ error: r.error }, r.status);
      }

      // ---------- the user's Etsy shop (cross-listing vintage items; etsy.js) ----------
      if (parts[1] === "etsy" && parts.length === 3) {
        if (parts[2] === "status" && m === "GET") {
          const on = await etsyOn();
          const a = on ? await db.prepare("SELECT shop_name, created_at FROM etsy_accounts WHERE user_id=?").bind(userId).first() : null;
          return J({ configured: on, connected: !!a, shop_name: a?.shop_name || null, notice: etsy.NOTICE });
        }
        if (parts[2] === "connect" && m === "POST") {
          if (!(await etsyOn())) return J({ error: "Etsy listing isn't switched on yet." }, 503);
          const cb = await readJson(request);
          const state = (cb.native ? "n" : "w") + randHex(24), verifier = etsy.newVerifier();
          await db.prepare("DELETE FROM etsy_oauth_states WHERE created_at < ?").bind(new Date(Date.now() - 3600e3).toISOString()).run();
          await db.prepare("INSERT INTO etsy_oauth_states (state,user_id,verifier,created_at) VALUES (?,?,?,?)").bind(state, userId, verifier, now()).run();
          return J({ url: etsy.consentUrl(env, state, await etsy.challengeFor(verifier)) });
        }
        if (parts[2] === "connection" && m === "DELETE") {
          const r = await db.prepare("DELETE FROM etsy_accounts WHERE user_id=?").bind(userId).run();
          return J({ disconnected: r.meta?.changes || 0 });
        }
      }

      // ---------- the user's eBay connection ----------
      if (parts[1] === "ebay" && parts.length === 3) {
        if (parts[2] === "status" && m === "GET") {
          const a = await db.prepare("SELECT ebay_username, postal_code, created_at FROM ebay_accounts WHERE user_id=?").bind(userId).first();
          return J({ configured: ebay.ebayConfigured(env), connected: !!a, username: a?.ebay_username || null,
                     postal_code: a?.postal_code || null, signup_url: ebay.SIGNUP_URL,
                     listing_credits: listingCredits(env) });
        }
        if (parts[2] === "connect" && m === "POST") {
          if (!ebay.ebayConfigured(env)) return J({ error: "eBay listing isn't switched on yet." }, 503);
          // "n" = started in the Android app (sign-in runs in a Custom Tab, and the callback hands
          // back to the app by its URL scheme); "w" = a browser tab that simply returns to "/".
          const cb = await readJson(request);
          const state = (cb.native ? "n" : "w") + randHex(24);
          await db.prepare("DELETE FROM ebay_oauth_states WHERE created_at < ?").bind(new Date(Date.now() - 3600e3).toISOString()).run();
          await db.prepare("INSERT INTO ebay_oauth_states (state,user_id,created_at) VALUES (?,?,?)").bind(state, userId, now()).run();
          return J({ url: ebay.consentUrl(env, state) });
        }
        if (parts[2] === "connection" && m === "DELETE") {
          // Forgetting the tokens is all we can do from here; the user revokes the app itself
          // in My eBay > Account > Third-party app access, and the app says so.
          const r = await db.prepare("DELETE FROM ebay_accounts WHERE user_id=?").bind(userId).run();
          return J({ disconnected: r.meta?.changes || 0 });
        }
        if (parts[2] === "settings" && m === "PUT") {
          const b = await readJson(request);
          const zip = String(b.postal_code || "").trim();
          if (!/^\d{5}(-\d{4})?$/.test(zip)) return J({ error: "Enter a 5-digit ZIP code" }, 400);
          const r = await db.prepare("UPDATE ebay_accounts SET postal_code=?, updated_at=? WHERE user_id=?").bind(zip.slice(0, 5), now(), userId).run();
          if (!r.meta?.changes) return J({ error: "Connect your eBay account first" }, 409);
          return J({ postal_code: zip.slice(0, 5) });
        }
      }

      // ---------- owner tools: which wallets (Apple Pay / Google Pay) Stripe Checkout will offer ----------
      if (parts[1] === "owner" && parts[2] === "stripe-probe" && m === "GET") {
        const meS = await db.prepare("SELECT email, connect_account_id FROM users WHERE id=?").bind(userId).first();
        if (!owner.isOwner(env, meS?.email)) return J({ error: "not found" }, 404);
        const pick = c => ({ name: c.name, is_default: c.is_default, active: c.active, livemode: c.livemode, parent: c.parent || null,
          ...Object.fromEntries(["card", "apple_pay", "google_pay", "link"].map(k => [k, c[k] ? { available: c[k].available, value: c[k].display_preference?.value } : null])) });
        const out = {};
        try { out.platform = ((await garage.stripe(env, "GET", "/v1/payment_method_configurations", { limit: 20 })).data || []).map(pick); } catch (e) { out.platform_error = String(e.message || e); }
        // A connected seller (the owner's own, else any) shows what garage-sale checkouts will offer.
        const acct = meS?.connect_account_id || (await db.prepare("SELECT connect_account_id FROM users WHERE connect_account_id IS NOT NULL LIMIT 1").first())?.connect_account_id;
        if (acct) { try { out.connected = ((await garage.stripe(env, "GET", "/v1/payment_method_configurations", { limit: 20 }, acct)).data || []).map(pick); } catch (e) { out.connected_error = String(e.message || e); } }
        return J(out);
      }
      // ---------- owner tools: check what the eBay after-sale APIs answer for the owner's account ----------
      if (parts[1] === "owner" && parts[2] === "ebay-probe" && m === "GET") {
        const meP = await db.prepare("SELECT email FROM users WHERE id=?").bind(userId).first();
        if (!owner.isOwner(env, meP?.email)) return J({ error: "not found" }, 404);
        const t = await ebay.userToken(env, db, userId);
        if (!t) return J({ error: "no eBay token" }, 409);
        const out = {};
        for (const [kind, path, pick] of ebaycare.SEARCHES) {
          const r = await ebaycare.postOrder(t.token, path);
          out[kind] = { status: r.status, scheme: r.scheme, count: r.ok ? pick(r.json || {}).length : null, error: r.ok ? null : JSON.stringify(r.json).slice(0, 300) };
        }
        const mr = await ebay.call(env, t.token, "GET", "/commerce/message/v1/conversation?conversation_type=FROM_MEMBERS&limit=1");
        out.messages = { status: mr.status, total: mr.ok ? mr.json?.total ?? null : null, error: mr.ok ? null : JSON.stringify(mr.json).slice(0, 300) };
        return J(out);
      }
      // ---------- shipping labels (Shippo; switched on per account, see labels.js) ----------
      if (parts[1] === "labels") {
        const me = await db.prepare("SELECT email FROM users WHERE id=?").bind(userId).first();
        const on = labels.labelsOn(env, me?.email);
        const set = await db.prepare("SELECT ship_from FROM seller_settings WHERE user_id=?").bind(userId).first();
        let from = null; try { from = set?.ship_from ? JSON.parse(set.ship_from) : null; } catch {}
        // Whose Shippo account pays: the seller's own (connected by OAuth), else the house account
        // for LABEL_USERS. Anyone else connects their Shippo account first.
        let le = await shippoauth.labelEnv(env, db, userId, on);
        // Anyone else pays by card first; the label is then bought on the house account (labelpay.js).
        if (!le && labelpay.payOn(env)) le = { env, payer: "paid" };
        if (parts[2] === "settings" && m === "GET")
          return J({ enabled: !!le, payer: le ? le.payer : null, connected: !!(le && le.payer === "seller"), can_connect: shippoauth.oauthReady(env), ship_from: from,
                     // The house account owner sees how close the Shippo plan is to its monthly cap.
                     house_month: le && le.payer === "house" ? { used: await labelpay.monthCount(db), cap: labelpay.houseCap(env) } : null });
        if (parts[2] === "connect" && m === "GET") {
          if (!shippoauth.oauthReady(env)) return J({ error: "Connecting a Shippo account isn't switched on yet." }, 503);
          return J({ url: shippoauth.authorizeUrl(env, await shippoauth.makeState(env, userId)) });
        }
        if (parts[2] === "disconnect" && m === "POST") { await shippoauth.disconnect(db, userId); return J({ ok: true }); }
        if (!le) return J({ error: "Connect your Shippo account to buy labels. Labels are billed to it by Shippo.", needs_shippo: true, can_connect: shippoauth.oauthReady(env) }, 403);
        if (parts[2] === "settings" && m === "PUT") {
          const c = labels.cleanFrom(await readJson(request));
          if (c.error) return J({ error: c.error }, 400);
          await db.prepare("INSERT INTO seller_settings (user_id,ship_from,updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET ship_from=excluded.ship_from, updated_at=excluded.updated_at")
            .bind(userId, JSON.stringify(c.value), now()).run();
          return J({ ship_from: c.value });
        }
        const b = m === "POST" ? await readJson(request) : {};
        if (parts[2] === "rates" && m === "POST") {
          if (!from) return J({ error: "Add your return address first.", needs_from: true }, 409);
          const t = await labels.orderFor(db, userId, b.kind, String(b.order_id || ""));
          if (t.error) return J({ error: t.error }, t.status);
          if (!t.to) return J({ error: "This order has no full shipping address." }, 409);
          const ap = await db.prepare("SELECT result_json FROM appraisals WHERE item_id=? AND status='done' ORDER BY created_at DESC LIMIT 1").bind(t.itemId).first();
          let est = null; try { est = ap?.result_json ? JSON.parse(ap.result_json).shipping : null; } catch {}
          const parcel = labels.parcelFor(est, b);
          if (!parcel) return J({ error: "Enter the box size and weight.", needs_parcel: true }, 409);
          const pkg = b.box_in ? null : packageFor(est);
          try {
            const q = await labels.labelRates(le.env, from, t.to, parcel, b.box_in ? [] : flatRateFits(est));
            // Pay-by-card sellers see what they'll actually be charged (label + card processing).
            if (le.payer === "paid") q.rates = q.rates.map(r => ({ ...r, pay: labelpay.priceLabel(Math.round(r.amount * 100), labelpay.feeCents(env)) }));
            return J({ ...q, parcel, package: pkg });
          }
          catch (e) { return J({ error: String(e.message || e) }, e.status || 502); }
        }
        // Pay-then-ship: card first (Stripe Checkout), label bought on the house account after.
        const buyFor = uid => row => labels.buyLabel(env, db, uid, row.kind, row.order_id, row.rate_id, row.label_cents, row.file_type,
                                                   env.PUBLIC_ORIGIN || url.origin, ctx, buyerShippedEmail);
        if (parts[2] === "pay" && m === "POST") {
          if (le.payer !== "paid") return J({ error: "Labels on this account are bought directly." }, 400);
          try { const r = await labelpay.startPay(env, db, userId, b, env.PUBLIC_ORIGIN || url.origin, garage.stripe); return J(r, r.status); }
          catch (e) { return J({ error: "Checkout didn't open: " + String(e.message || e) }, 502); }
        }
        if (parts[2] === "paid" && m === "POST") {
          try { const r = await labelpay.finishPay(env, db, userId, b.id, garage.stripe, buyFor(userId)); return J(r, r.status); }
          catch (e) { return J({ error: String(e.message || e) }, 502); }
        }
        if (parts[2] === "buy" && m === "POST") {
          if (le.payer === "paid") return J({ error: "Pay for the label first.", needs_payment: true }, 402);
          try {
            const r = await labels.buyLabel(le.env, db, userId, b.kind, String(b.order_id || ""), b.rate_id, b.amount_cents, b.file_type,
                                            env.PUBLIC_ORIGIN || url.origin, ctx, buyerShippedEmail);
            // Bought on the seller's own Shippo account: doesn't count toward the house cap.
            if (!r.error && le.payer === "seller") await db.prepare("UPDATE shipping_labels SET payer='seller' WHERE id=?").bind(r.label.id).run();
            return J(r.error ? { error: r.error, label: r.label || null } : r, r.status);
          } catch (e) { return J({ error: String(e.message || e) }, e.status || 502); }
        }
        // Void a label / book a USPS pickup (shipops.js). The Shippo account that paid does the work.
        const envFor = shipEnvFor(env, db);
        if (parts[2] === "void" && m === "POST") {
          try { const r = await shipops.voidLabel(env, db, userId, String(b.kind || ""), String(b.order_id || ""), envFor, garage.stripe); return J(r, r.status); }
          catch (e) { return J({ error: String(e.message || e) }, 502); }
        }
        if (parts[2] === "pickup-days" && m === "GET") return J({ days: shipops.pickupDays(), locations: shipops.LOCATIONS });
        if (parts[2] === "pickup" && m === "POST") {
          const l = await shipops.labelFor(db, userId, String(b.kind || ""), String(b.order_id || ""));
          if (!l) return J({ error: "No label for this order." }, 404);
          const se = await envFor(l);
          if (!se) return J({ error: "Reconnect your Shippo account first." }, 409);
          try { const r = await shipops.bookPickup(se, db, userId, String(b.kind), String(b.order_id), b, from, me?.email); return J(r, r.status); }
          catch (e) { return J({ error: String(e.message || e) }, 502); }
        }
        if (parts[2] === "for" && m === "GET") {
          // Paid but never came back from Stripe? Finish it now.
          const pend = await db.prepare("SELECT id FROM label_payments WHERE user_id=? AND kind=? AND order_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1")
            .bind(userId, url.searchParams.get("kind") || "", url.searchParams.get("order") || "").first();
          if (pend) { try { await labelpay.finishPay(env, db, userId, pend.id, garage.stripe, buyFor(userId)); } catch (e) { console.log("label finish", String(e.message || e)); } }
          const k = url.searchParams.get("kind") || "", o = url.searchParams.get("order") || "";
          const l = await db.prepare("SELECT kind, order_id, carrier, service, amount_cents, tracking, label_url, created_at, payer, pickup FROM shipping_labels WHERE user_id=? AND kind=? AND order_id=?")
            .bind(userId, k, o).first();
          if (l) { l.can_void = shipops.canVoid(l); try { l.pickup = l.pickup ? JSON.parse(l.pickup) : null; } catch { l.pickup = null; } }
          const v = await db.prepare("SELECT service, amount_cents, tracking, voided_at, void_status, payer, card_refund_id FROM shipping_labels WHERE user_id=? AND kind=? AND void_of=? ORDER BY voided_at DESC LIMIT 1")
            .bind(userId, k, o).first();
          return J({ label: l || null, voided: v || null });
        }
        return J({ error: "not found" }, 404);
      }

      // ---------- profit report ----------
      if (parts[1] === "profit" && m === "GET") {
        const range = { from: String(url.searchParams.get("from") || "").slice(0, 10), to: String(url.searchParams.get("to") || "").slice(0, 10) };
        const rep = await profit.profitRows(db, userId, range);
        if (parts[2] === "csv")
          return new Response(profit.profitCsv(rep), { headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store",
            "content-disposition": `attachment; filename="guestimator-profit-${range.from || "all"}-${range.to || now().slice(0, 10)}.csv"` } });
        return J({ ...rep, inventory: await profit.inventorySummary(db, userId) });
      }

      // ---------- price check: live eBay listings vs recent eBay sales ----------
      if (parts[1] === "ebay" && parts[2] === "pricecheck" && parts.length === 3 && m === "GET")
        return J(await priceCheck(env, db, userId));
      // Change a live listing's price from the item page (up or down; offer limits move with it).
      if (parts[1] === "ebay" && parts[2] === "listings" && parts[4] === "price" && m === "POST") {
        const b = await readJson(request);
        try { const r = await nudges.changePrice(env, db, userId, parts[3], b.price_cents); return J(r.ok ? r : { error: r.error }, r.status); }
        catch (e) { return J({ error: String(e.message || e) }, 502); }
      }
      if (parts[1] === "ebay" && parts[2] === "listings" && parts[4] === "best-offer" && m === "POST") {
        const b = await readJson(request);
        try { const r = await nudges.setListingBestOffer(env, db, userId, parts[3], b.enabled !== false, b.min_cents); return J(r.ok ? r : { error: r.error }, r.status); }
        catch (e) { return J({ error: String(e.message || e) }, 502); }
      }

      // The seller's eBay return policies, for the listing form (and what each means to a buyer).
      if (parts[1] === "ebay" && parts[2] === "return-policies" && m === "GET") {
        const ut = await ebay.userToken(env, db, userId);
        if (!ut) return J({ error: "Connect your eBay account first", needs_connect: true }, 409);
        const pol = await ebay.listPolicies(env, ut.token);
        return J({ policies: pol.return, new30: ebay.NEW_RETURNS_30 });
      }

      // Change a live listing's return policy: one of the seller's own, or "new30" (created once).
      if (parts[1] === "ebay" && parts[2] === "listings" && parts[4] === "returns" && m === "POST") {
        const b = await readJson(request);
        const l = await db.prepare("SELECT l.*, i.listing_status FROM ebay_listings l JOIN items i ON i.id=l.item_id WHERE l.id=? AND l.user_id=?").bind(parts[3], userId).first();
        if (!l) return J({ error: "not found" }, 404);
        if (l.status !== "published" || l.listing_status !== "live" || !l.offer_id) return J({ error: "This listing isn't live any more." }, 409);
        const ut = await ebay.userToken(env, db, userId);
        if (!ut) return J({ error: "Connect your eBay account first", needs_connect: true }, 409);
        try {
          const pol = await ebay.listPolicies(env, ut.token);
          const pid = b.policy_id === ebay.NEW_RETURNS_30 ? await ebay.createReturnPolicy(env, ut.token)
            : pol.return.some(p => p.id === b.policy_id) ? b.policy_id : null;
          if (!pid) return J({ error: "Pick one of your eBay return policies" }, 400);
          const u = await ebay.updateOfferReturns(env, ut.token, l.offer_id, pid);
          if (u.error) return J({ error: u.error }, 502);
          const after = await ebay.listPolicies(env, ut.token);
          return J({ ok: true, return_policy_id: pid, returns: (after.return.find(p => p.id === pid) || {}).summary || null });
        } catch (e) { return J({ error: String(e.message || e) }, 502); }
      }
      // Send this week's summary to me now (preview; does not count as the week's email).
      if (parts[1] === "weekly" && parts[2] === "preview" && m === "POST") {
        const me = await db.prepare("SELECT email FROM users WHERE id=?").bind(userId).first();
        const origin = env.PUBLIC_ORIGIN || url.origin;
        const sum = await weekly.weeklySummary(db, userId);
        const mail = weekly.weeklyEmail(sum, origin, await weekly.offLink(env, origin, userId));
        const r = await sendAlert(env, { to: me?.email, ...mail });
        return J({ sent: !!r.sent, why: r.why || null, subject: mail.subject, listings: sum.listings.length, sold: sum.sold.length });
      }

      // ---------- offers to interested buyers (eBay watchers) ----------
      if (parts[1] === "ebay" && parts[2] === "interested" && m === "GET") {
        try { const r = await watchers.interested(env, db, userId); return J(r.error ? { error: r.error, needs_connect: r.needs_connect } : r, r.status); }
        catch (e) { return J({ error: String(e.message || e) }, 502); }
      }
      if (parts[1] === "ebay" && parts[2] === "listings" && parts[4] === "watcher-offer" && m === "POST") {
        const b = await readJson(request);
        try { const r = await watchers.sendOffer(env, db, userId, parts[3], b.pct, { message: b.message }); return J(r.error ? { error: r.error } : r, r.status); }
        catch (e) { return J({ error: String(e.message || e) }, 502); }
      }
      // ---------- price-drop nudges for slow eBay listings ----------
      if (parts[1] === "ebay" && parts[2] === "slow") {
        if (parts.length === 3 && m === "GET")
          return J({ listings: (await nudges.slowListings(db, userId)).map(({ user_id, offer_id, sku, ...x }) => x) });
        if (parts[4] === "lower" && m === "POST") {
          const b = await readJson(request);
          try { const r = await nudges.lowerPrice(env, db, userId, parts[3], b.price_cents); return J(r.ok ? r : { error: r.error }, r.status); }
          catch (e) { return J({ error: String(e.message || e) }, 502); }
        }
        if (parts[4] === "keep" && m === "POST") {
          const r = await db.prepare("UPDATE ebay_listings SET nudge_dismissed_at=? WHERE id=? AND user_id=?").bind(now(), parts[3], userId).run();
          return r.meta?.changes ? J({ ok: true }) : J({ error: "not found" }, 404);
        }
        return J({ error: "not found" }, 404);
      }

      // ---------- eBay sales of Guestimator listings ----------
      if (parts[1] === "ebay" && parts[2] === "orders") {
        // List (reading eBay first if the last read is more than two minutes old).
        if (parts.length === 3 && m === "GET") {
          const a = await db.prepare("SELECT orders_synced_at, fulfillment_ok FROM ebay_accounts WHERE user_id=?").bind(userId).first();
          let sync = null;
          if (a && a.fulfillment_ok !== 0 && (!a.orders_synced_at || Date.now() - Date.parse(a.orders_synced_at) > 120e3)) {
            try { sync = await ebayOrders.syncOrders(env, db, userId); } catch (e) { sync = { ok: false, error: String(e.message || e), new: [] }; }
            for (const id of sync.new || []) ctx.waitUntil(ebaySoldAlert(db, env, id, env.PUBLIC_ORIGIN || url.origin).catch(e => console.log("ebaySoldAlert", e)));
          }
          const { results } = await db.prepare(
            "SELECT e.id, e.order_id, e.item_id, e.title, e.quantity, e.buyer, e.total_cents, e.ship_to, e.ship_service, e.ship_by, e.status, e.tracking, e.ordered_at, " +
            "COALESCE(i.ai_title, i.name, e.title) AS item_title, (SELECT r2_key FROM photos p WHERE p.item_id=e.item_id ORDER BY p.sort, p.created_at LIMIT 1) AS thumb_key " +
            "FROM ebay_orders e LEFT JOIN items i ON i.id=e.item_id WHERE e.user_id=? AND (e.status IN ('NOT_STARTED','IN_PROGRESS') OR e.ordered_at > ?) ORDER BY e.ordered_at DESC LIMIT 50")
            .bind(userId, new Date(Date.now() - 30 * 86400e3).toISOString()).all();
          return J({ connected: !!a, needs_reconnect: !!a && (a.fulfillment_ok === 0 || !!sync?.needs_reconnect), error: sync && !sync.ok ? sync.error || null : null,
                     orders: results.map(r => ({ ...r, thumb: r.thumb_key ? `/p/${r.thumb_key}` : null })) });
        }
        if (parts[4] === "ship" && m === "POST") {
          const b = await readJson(request);
          const r = await ebayOrders.markShipped(env, db, userId, decodeURIComponent(parts[3]), b.tracking, b.carrier);
          return J(r.ok ? { ok: true, carrier: r.carrier } : { error: r.error }, r.status);
        }
        if (parts[4] === "slip" && m === "GET") {
          const o = await db.prepare("SELECT e.*, COALESCE(i.ai_title, i.name, e.title) AS item_title FROM ebay_orders e LEFT JOIN items i ON i.id=e.item_id WHERE e.id=? AND e.user_id=?")
            .bind(decodeURIComponent(parts[3]), userId).first();
          if (!o) return J({ error: "not found" }, 404);
          const acct = await db.prepare("SELECT ebay_username FROM ebay_accounts WHERE user_id=?").bind(userId).first();
          const ap = await db.prepare("SELECT result_json FROM appraisals WHERE item_id=? AND status='done' ORDER BY created_at DESC LIMIT 1").bind(o.item_id).first();
          let ship = null; try { ship = ap?.result_json ? JSON.parse(ap.result_json).shipping : null; } catch {}
          return H(garage.slipHtml({ title: acct?.ebay_username ? `eBay seller ${acct.ebay_username}` : "eBay seller" },
            { id: o.id, ref: o.order_id, channel: "ebay", fulfilment: "ship", status: o.status === "CANCELLED" ? "refund_needed" : "paid",
              item_cents: null, ship_cents: null, quantity: o.quantity, total_cents: o.total_cents, ship_address: o.ship_to,
              tracking: o.tracking, created_at: o.ordered_at }, o.item_title || "Item", ship), 200, "no-store");
        }
        return J({ error: "not found" }, 404);
      }

      // ---------- Guestimator: one flat list of the user's items ----------
      // Items still hang off a `sales` row because the D1 schema is shared with Bottle Tree. The
      // app never shows sales: every item goes into one per-user container, made on first use.
      if (parts[1] === "items" && parts.length === 2) {
        if (m === "GET") {
          const { results } = await db.prepare(
            "SELECT i.id, i.name, i.ai_title, i.price_cents, i.created_at, " +
            "(SELECT r2_key FROM photos p WHERE p.item_id=i.id ORDER BY p.sort, p.created_at LIMIT 1) AS thumb_key, " +
            "(SELECT status FROM appraisals a WHERE a.item_id=i.id ORDER BY a.created_at DESC LIMIT 1) AS appraisal_status, " +
            "(SELECT status FROM ebay_listings e WHERE e.item_id=i.id ORDER BY e.created_at DESC LIMIT 1) AS ebay_status " +
            "FROM items i JOIN sales s ON s.id=i.sale_id WHERE s.user_id=? ORDER BY i.created_at DESC LIMIT 500").bind(userId).all();
          return J(results);
        }
        if (m === "POST") {
          const b = await readJson(request);
          let sale = await db.prepare("SELECT id FROM sales WHERE user_id=? AND name=? ORDER BY created_at LIMIT 1").bind(userId, GUESS_BUCKET).first();
          if (!sale) {
            sale = { id: uid() };
            await db.prepare("INSERT INTO sales (id,name,status,created_at,user_id) VALUES (?,?,'open',?,?)").bind(sale.id, GUESS_BUCKET, now(), userId).run();
          }
          const id = uid();
          await db.prepare("INSERT INTO items (id,sale_id,name,price_cents,status,created_at,description,markings) VALUES (?,?,?,0,'available',?,?,?)")
            .bind(id, sale.id, (b.name || "").trim() || "New item", now(), (b.description || "").trim() || null, (b.markings || "").trim() || null).run();
          return J({ id });
        }
      }

      // ---------- sales ----------
      if (parts[1] === "sales" && parts.length === 2) {
        if (m === "GET") {
          const { results } = await db.prepare(
            "SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.sale_id=s.id) AS items, " +
            "(SELECT COALESCE(SUM(total_cents),0) FROM txns t WHERE t.sale_id=s.id AND t.status='complete') AS revenue_cents " +
            "FROM sales s WHERE s.user_id=? ORDER BY created_at DESC").bind(userId).all();
          return J(results);
        }
        if (m === "POST") {
          const b = await readJson(request);
          const name = (b.name || "").trim() || "Untitled sale";
          const id = uid();
          await db.prepare("INSERT INTO sales (id,name,status,created_at,user_id) VALUES (?,?,'open',?,?)").bind(id, name, now(), userId).run();
          if (b.seller && b.seller.trim())
            await db.prepare("INSERT OR IGNORE INTO sellers (id,user_id,name,created_at) VALUES (?,?,?,?)").bind(uid(), userId, b.seller.trim(), now()).run();
          return J({ id, name });
        }
      }
      if (parts[1] === "sales" && parts.length >= 3) {
        const sid = parts[2];
        if (!(await ownsSale(sid))) return J({ error: "not found" }, 404);
        if (parts.length === 3 && m === "GET") {
          const sale = await db.prepare("SELECT * FROM sales WHERE id=?").bind(sid).first();
          const sellers = (await db.prepare("SELECT id,name FROM sellers WHERE user_id=? ORDER BY name COLLATE NOCASE").bind(userId).all()).results;
          const items = (await db.prepare(
            "SELECT i.*, (SELECT r2_key FROM photos p WHERE p.item_id=i.id ORDER BY p.sort, p.created_at LIMIT 1) AS thumb_key, " +
            "(SELECT status FROM appraisals a WHERE a.item_id=i.id ORDER BY a.created_at DESC LIMIT 1) AS appraisal_status " +
            "FROM items i WHERE i.sale_id=? ORDER BY i.created_at DESC").bind(sid).all()).results;
          const txns = (await db.prepare("SELECT * FROM txns WHERE sale_id=? ORDER BY created_at DESC").bind(sid).all()).results;
          return J({ sale, sellers, items, txns });
        }
        if (parts.length === 3 && m === "DELETE") {
          // A sale with recorded sales is the dealer's books — refuse unless they say so explicitly.
          // A voided transaction is not takings, so it must not be what makes deleting a sale
          // feel dangerous — otherwise every corrected mistake leaves a permanent scary warning.
          const sold = await db.prepare("SELECT COUNT(*) AS n FROM txns WHERE sale_id=? AND status='complete'").bind(sid).first();
          if (sold.n && url.searchParams.get("force") !== "1")
            return J({ error: "This sale has recorded sales", sold: sold.n, needs_force: true }, 409);
          const ps = (await db.prepare(
            "SELECT p.r2_key FROM photos p JOIN items i ON i.id=p.item_id WHERE i.sale_id=?").bind(sid).all()).results;
          // Nothing below can be undone, and a statement is a promise about money. If any item in
          // this sale has been settled on a statement that was issued or paid, deleting the sale
          // pulls the evidence out from under a document a dealer is holding. statement_items
          // keeps its own copy of the line, so the figures would survive - but the items behind
          // them would not, and "where did the March sale go" is not a question to answer after
          // the fact. Drafts do not block: nothing has been handed over yet.
          const settled = await db.prepare(
            "SELECT COUNT(*) AS n, SUM(st.status='paid') AS paid FROM statement_items si " +
            "JOIN statements st ON st.id=si.statement_id " +
            "WHERE st.status IN ('issued','paid') AND si.item_id IN (SELECT id FROM items WHERE sale_id=?)")
            .bind(sid).first();
          if (settled.n) {
            // A paid statement cannot be voided — that is deliberate, it records money that
            // actually moved — so for those the honest answer is that this sale is not going
            // anywhere, not "void it first", which would send the owner to a button that
            // refuses them.
            const one = settled.n === 1;
            return J({ error: `${settled.n} item${one ? "" : "s"} in this sale ${one ? "is" : "are"} on a ` +
              (settled.paid
                ? `statement that has already been paid, so this sale has to stay. Anything that ` +
                  `needs correcting goes on that dealer's next statement as an adjustment.`
                : `statement that has already been issued. Void that statement first if this ` +
                  `really needs to go.`),
              settled_items: settled.n, paid_items: settled.paid || 0 }, 409);
          }
          // R2 deletes are best-effort: a failed key must not leave the rows behind.
          await Promise.all(ps.map(x => env.PHOTOS.delete(x.r2_key).catch(() => {})));
          await db.prepare("DELETE FROM photos WHERE item_id IN (SELECT id FROM items WHERE sale_id=?)").bind(sid).run();
          await db.prepare("DELETE FROM appraisals WHERE item_id IN (SELECT id FROM items WHERE sale_id=?)").bind(sid).run();
          await db.prepare("DELETE FROM items WHERE sale_id=?").bind(sid).run();
          await db.prepare("DELETE FROM txns WHERE sale_id=?").bind(sid).run();
          // Sellers are the dealer's, not the sale's — deleting a sale must not delete their consignors.
          const r = await db.prepare("DELETE FROM sales WHERE id=? AND user_id=?").bind(sid, userId).run();
          return J({ deleted: r.meta.changes, photos: ps.length });
        }
        if (parts[3] === "items" && m === "POST") {
          const b = await readJson(request);
          const name = (b.name || "").trim() || "New item";
          const price_cents = b.price === undefined || b.price === "" || b.price === null ? 0 : Math.round(Number(b.price) * 100);
          if (!Number.isFinite(price_cents) || price_cents < 0) return J({ error: "bad price" }, 400);
          const id = uid();
          await db.prepare("INSERT INTO items (id,sale_id,seller_id,name,price_cents,status,created_at,description,markings) VALUES (?,?,?,?,?,'available',?,?,?)")
            .bind(id, sid, b.seller_id || null, name, price_cents, now(), (b.description || "").trim() || null, (b.markings || "").trim() || null).run();
          return J({ id });
        }
      }

      // ---------- items: photos, appraisal, publish ----------
      if (parts[1] === "items" && parts.length >= 3) {
        const iid = parts[2];
        const item = await ownsItem(iid);
        if (!item) return J({ error: "not found" }, 404);

        if (parts.length === 3 && m === "GET") return J(await itemBundle(db, iid));
        // Public price guide: is this item on it, and the seller's switch to keep it off.
        if (parts[3] === "guide" && m === "GET") return J(await priceguide.guideStatus(db, iid, env.PUBLIC_ORIGIN || url.origin));
        if (parts[3] === "guide" && m === "POST") {
          const b = await readJson(request);
          await db.prepare("UPDATE items SET guide_hidden=? WHERE id=?").bind(b.hidden ? 1 : null, iid).run();
          return J(await priceguide.guideStatus(db, iid, env.PUBLIC_ORIGIN || url.origin));
        }
        if (parts.length === 3 && m === "DELETE") {
          if (item.status !== "available") return J({ error: "sold items can't be deleted" }, 400);
          const ps = (await db.prepare("SELECT r2_key FROM photos WHERE item_id=?").bind(iid).all()).results;
          await Promise.all(ps.map(x => env.PHOTOS.delete(x.r2_key)));
          await db.prepare("DELETE FROM photos WHERE item_id=?").bind(iid).run();
          await db.prepare("DELETE FROM appraisals WHERE item_id=?").bind(iid).run();
          await db.prepare("DELETE FROM estimate_shares WHERE item_id=?").bind(iid).run();   // a deleted item's share page goes too
          const r = await db.prepare("DELETE FROM items WHERE id=?").bind(iid).run();
          return J({ deleted: r.meta.changes });
        }
        // ---------- "Share your price": a public page for this item's latest estimate (share.js) ----------
        if (parts[3] === "share" && m === "POST") {
          const s = await share.createShare(db, userId, iid);
          return s.token ? J({ url: `${env.PUBLIC_ORIGIN || url.origin}/e/${s.token}` }) : J({ error: s.error }, s.status);
        }
        // ---------- "How close was it?": rate the latest estimate, earn a free one ----------
        // One rating per estimate (re-rating updates it). The first rating of a paid estimate
        // earns 1 credit, up to RATING_CREDITS_PER_MONTH a month; free follow-ups earn nothing.
        if (parts[3] === "rating" && m === "POST") {
          const b = await readJson(request);
          const stars = Math.round(Number(b.stars));
          if (!(stars >= 1 && stars <= 5)) return J({ error: "Pick 1 to 5 stars" }, 400);
          const ap = await db.prepare("SELECT id, funded_by FROM appraisals WHERE item_id=? AND status='done' ORDER BY created_at DESC LIMIT 1").bind(iid).first();
          if (!ap) return J({ error: "estimate this item first" }, 409);
          const note = String(b.note || "").trim().slice(0, 500) || null, ts = now();
          const had = await db.prepare("SELECT credited FROM estimate_ratings WHERE appraisal_id=?").bind(ap.id).first();
          if (had) {
            await db.prepare("UPDATE estimate_ratings SET stars=?, note=COALESCE(?,note), updated_at=? WHERE appraisal_id=?").bind(stars, note, ts, ap.id).run();
            return J({ ok: true, stars, credited: 0, already: true });
          }
          const monthStart = ts.slice(0, 7) + "-01";
          const used = (await db.prepare("SELECT COALESCE(SUM(credited),0) AS n FROM estimate_ratings WHERE user_id=? AND created_at>=?").bind(userId, monthStart).first())?.n || 0;
          const credit = ap.funded_by && used < ratingCredits(env) ? 1 : 0;
          const stmts = [db.prepare("INSERT INTO estimate_ratings (appraisal_id,user_id,item_id,stars,note,credited,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
            .bind(ap.id, userId, iid, stars, note, credit, ts, ts)];
          if (credit) stmts.push(
            db.prepare("UPDATE users SET credits=credits+1 WHERE id=?").bind(userId),
            db.prepare("INSERT INTO billing_events (id,user_id,source,type,credits_delta,raw_json,created_at) VALUES (?,?,'usage','rating_reward',1,?,?)")
              .bind(uid(), userId, JSON.stringify({ appraisal_id: ap.id, stars }), ts));
          await db.batch(stmts);
          return J({ ok: true, stars, credited: credit, left_this_month: Math.max(0, ratingCredits(env) - used - credit) });
        }
        // ---------- "Show the price anyway": the dealer accepts a low-confidence estimate ----------
        // Free - no new run. Only for low confidence; when the photos and the dealer's words name
        // different objects there is no single price to show, so that still needs an answer.
        if (parts[3] === "accept-estimate" && m === "POST") {
          const ap = await db.prepare("SELECT id, result_json FROM appraisals WHERE item_id=? AND status='done' ORDER BY created_at DESC LIMIT 1").bind(iid).first();
          let res = null; try { res = ap?.result_json ? JSON.parse(ap.result_json) : null; } catch {}
          if (!res) return J({ error: "estimate this item first" }, 409);
          if (!res.needs_clarification) return J({ ok: true });
          if (res.needs_clarification.candidates) return J({ error: "Pick which of the two it is first." }, 409);
          if (!(res.price_range && res.price_range.high > 0)) return J({ error: "There's no price to show yet — answer a question or re-run it." }, 409);
          res.accepted_uncertain = { reason: res.needs_clarification.reason, at: now() };
          res.needs_clarification = null;
          res.warnings = [...(res.warnings || []), "you chose to see this price although the identification is uncertain — check the comparables before relying on it"];
          await db.prepare("UPDATE appraisals SET result_json=? WHERE id=?").bind(JSON.stringify(res), ap.id).run();
          return J({ ok: true });
        }
        // ---------- Etsy cross-listing: what can be offered, list it, take it down ----------
        if (parts[3] === "etsy" && parts.length === 4 && m === "GET") {
          if (!(await etsyOn())) return J({ configured: false });   // hidden for accounts not allowed yet
          const bundle = await itemBundle(db, iid);
          return J(await etsy.plan(env, db, userId, { item, result: bundle.appraisal?.result || null }));
        }
        if (parts[3] === "etsy" && parts[4] === "publish" && m === "POST") {
          if (!(await etsyOn())) return J({ error: "Etsy listing isn't switched on yet." }, 503);
          const bundle = await itemBundle(db, iid);
          const r = await etsy.publish(env, db, userId, { item, photos: bundle.photos, result: bundle.appraisal?.result || null },
            await readJson(request), listingCredits(env), { consume: consumeEstimate, refund: refundEstimate });
          if (r.body.paywall) r.body.plan = await planFor(db, userId);
          return J(r.body, r.status);
        }
        if (parts[3] === "etsy" && parts[4] === "end" && m === "POST") {
          const r = await etsy.endEtsyListing(env, db, iid, "taken down by the seller");
          return J(r, r.ended ? 200 : 409);
        }
        // ---------- eBay: build the draft a person reviews ----------
        if (parts[3] === "ebay" && parts[4] === "draft" && m === "POST") {
          if (!ebay.ebayConfigured(env)) return J({ error: "eBay listing isn't switched on yet." }, 503);
          const bundle = await itemBundle(db, iid);
          if (!bundle.appraisal?.result || bundle.appraisal.status !== "done")
            return J({ error: "Get an estimate first — the listing is written from it." }, 409);
          const last = await db.prepare("SELECT * FROM ebay_listings WHERE item_id=? ORDER BY created_at DESC LIMIT 1").bind(iid).first();
          if (last?.status === "published")
            return J({ draft: null, listing: { status: "published", url: last.listing_url, listing_id: last.listing_id } });
          const db0 = await readJson(request);
          // "List on eBay" tapped before the listing text was written (it now follows the estimate).
          if (!bundle.appraisal.result.listing?.description) await ensureListingCopy(env, db, bundle.appraisal.id, item, bundle.appraisal.result);
          const draft = await ebay.buildDraft(env, { item, photos: bundle.photos, result: bundle.appraisal.result,
                                                     origin: env.PUBLIC_ORIGIN || url.origin, categoryId: db0.category_id });
          const ts = now();
          if (last) await db.prepare("UPDATE ebay_listings SET draft_json=?, category_id=?, updated_at=? WHERE id=?")
            .bind(JSON.stringify(draft), draft.category?.id || null, ts, last.id).run();
          else await db.prepare("INSERT INTO ebay_listings (id,item_id,user_id,sku,status,category_id,draft_json,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?,?,?)")
            .bind(uid(), iid, userId, ebay.skuFor(iid), draft.category?.id || null, JSON.stringify(draft), ts, ts).run();
          return J({ draft, listing: last ? { status: last.status, error: last.error } : { status: "draft" } });
        }

        // ---------- eBay: preview (fees) or publish the reviewed draft on the user's own account ----------
        // preview: everything publish does EXCEPT publishing - the item and an unpublished offer
        // are saved on eBay (invisible to buyers, free) and eBay's own fee calculator is asked what
        // listing it would cost. No credit is taken. Derek, 2026-09-27: "it costs money to list",
        // so nobody should list without seeing eBay's fees first. publish reuses the saved offer.
        if (parts[3] === "ebay" && (parts[4] === "publish" || parts[4] === "preview") && m === "POST") {
          const preview = parts[4] === "preview";
          if (!ebay.ebayConfigured(env)) return J({ error: "eBay listing isn't switched on yet." }, 503);
          const b = await readJson(request);
          const title = ebay.ebayTitle(b.title);
          const price = Math.round(Number(b.price) * 100) / 100;
          if (!title) return J({ error: "Give the listing a title" }, 400);
          if (!(price >= 0.99)) return J({ error: "Set a price of at least $0.99" }, 400);
          if (!b.category_id) return J({ error: "Pick an eBay category" }, 400);
          if (!String(b.description || "").trim()) return J({ error: "Add a description" }, 400);
          // The category decides: some take no condition at all, the rest only their own list.
          const catConds = await ebay.categoryConditions(env, b.category_id);
          const condition = ebay.conditionApplies(catConds) ? b.condition : null;
          if (ebay.conditionApplies(catConds) && !ebay.conditionAllowed(b.condition, catConds))
            return J({ error: "Pick a condition this eBay category accepts" }, 400);

          const ut = await ebay.userToken(env, db, userId);
          if (!ut) return J({ error: "Connect your eBay account first", needs_connect: true }, 409);
          const zip = String(b.postal_code || ut.acct.postal_code || "").trim();
          if (!/^\d{5}(-\d{4})?$/.test(zip)) return J({ error: "Enter the ZIP code you ship from", needs_zip: true }, 400);
          if (zip.slice(0, 5) !== ut.acct.postal_code)
            await db.prepare("UPDATE ebay_accounts SET postal_code=?, updated_at=? WHERE user_id=?").bind(zip.slice(0, 5), now(), userId).run();

          let row = await db.prepare("SELECT * FROM ebay_listings WHERE item_id=? ORDER BY created_at DESC LIMIT 1").bind(iid).first();
          if (row?.status === "published")
            return J({ error: "This item is already listed on eBay", url: row.listing_url, already: true }, 409);
          // Two taps on List must not make two listings or take two credits.
          if (row?.status === "publishing" && Date.now() - Date.parse(row.updated_at) < 120e3)
            return J({ error: "Already sending this one to eBay — give it a moment." }, 409);

          const bundle = await itemBundle(db, iid);
          const images = ebay.imageUrls(bundle.photos, env.PUBLIC_ORIGIN || url.origin);
          if (!images.length) return J({ error: "eBay needs at least one JPEG or PNG photo of the item" }, 400);
          const spec = ebay.aspectSpec(await ebay.categoryAspects(env, b.category_id));
          const aspects = ebay.cleanAspects(b.aspects || {}, spec);
          const missing = ebay.missingRequired(aspects, spec);
          if (missing.length) return J({ error: `eBay requires: ${missing.join(", ")}`, missing }, 400);

          const tok = ut.token;
          const pol = await ebay.listPolicies(env, tok);
          if (pol.notOptedIn) {
            await ebay.optIn(env, tok);
            return J({ error: "eBay is switching on selling policies for your account. That usually takes a few minutes — tap List again shortly.",
                       retry_later: true }, 409);
          }
          if (pol.error) return J({ error: `eBay: ${pol.error}` }, 502);
          let fulfillmentPolicyId = pol.fulfillment.some(p => p.id === b.fulfillment_policy_id) ? b.fulfillment_policy_id : null;
          if (!fulfillmentPolicyId) {
            if (b.shipping_cost === undefined || b.shipping_cost === null || b.shipping_cost === "")
              return J({ error: "How much should the buyer pay for shipping?", needs_shipping: true, policies: pol.fulfillment }, 400);
            if (!(Number(b.shipping_cost) >= 0)) return J({ error: "Shipping can't be negative" }, 400);
          }

          const ts = now();
          const working = preview ? "draft" : "publishing";
          if (!row) {
            row = { id: uid(), offer_id: null };
            await db.prepare("INSERT INTO ebay_listings (id,item_id,user_id,sku,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
              .bind(row.id, iid, userId, ebay.skuFor(iid), working, ts, ts).run();
          } else await db.prepare("UPDATE ebay_listings SET status=?, error=NULL, updated_at=? WHERE id=?").bind(working, ts, row.id).run();

          const credits = preview ? 0 : listingCredits(env);
          let fundedBy = null;
          if (credits) {
            fundedBy = await consumeEstimate(db, userId);
            if (!fundedBy) {
              await db.prepare("UPDATE ebay_listings SET status='draft', updated_at=? WHERE id=?").bind(now(), row.id).run();
              return J({ error: "Listing on eBay uses a credit, and you're out", paywall: true, plan: await planFor(db, userId) }, 402);
            }
          }
          const fail = async (msg, stage, offerId) => {
            if (fundedBy) await refundEstimate(db, userId, fundedBy, `ebay listing failed: ${String(msg).slice(0, 250)}`);
            await db.prepare("UPDATE ebay_listings SET status='error', error=?, offer_id=COALESCE(?,offer_id), updated_at=? WHERE id=?")
              .bind(String(msg).slice(0, 1000), offerId || null, now(), row.id).run();
            return J({ error: msg, stage, refunded: !!fundedBy }, 502);
          };
          try {
            if (!fulfillmentPolicyId) fulfillmentPolicyId = await ebay.createFulfillmentPolicy(env, tok, b.shipping_cost, b.handling_days, ebay.shipService(b.shipping_service));
            const paymentPolicyId = pol.payment[0]?.id || await ebay.createPaymentPolicy(env, tok);
            // The seller picks the return policy on the form: one of theirs, or a new 30-day one.
            // Nothing picked means 30-day returns: their own 30-day policy, else a new one.
            const picked = ebay.pickReturnPolicy(pol.return, b.return_policy_id);
            const returnPolicyId = picked === ebay.NEW_RETURNS_30 ? await ebay.createReturnPolicy(env, tok) : picked;
            const returns = (pol.return.find(p => p.id === returnPolicyId) || {}).summary || ebay.returnSummary({ returnsAccepted: true, returnPeriod: { value: 30, unit: "DAY" }, returnShippingCostPayer: "BUYER" });
            const locationKey = await ebay.ensureLocation(env, tok, zip);
            const text = String(b.description).trim();
            // CHANGED 2026-10-05: Best Offer is OFF unless the seller ticks it (Derek: it "auto put in
            // to accept less, which I didn't say"). When on, its thresholds come from this price
            // and the floor the estimate set (never auto-accept below what we said to take).
            const apBO = await db.prepare("SELECT result_json FROM appraisals WHERE item_id=? AND status='done' ORDER BY created_at DESC LIMIT 1").bind(iid).first();
            let prBO = null; try { prBO = JSON.parse(apBO?.result_json || "null")?.price_range || null; } catch {}
            const bestOffer = b.best_offer === true ? ebay.bestOfferTerms(price, prBO?.floor || prBO?.low) : null;
            const L = {
              sku: ebay.skuFor(iid), offerId: row.offer_id, title, price, categoryId: b.category_id, condition,
              conditionDescription: String(b.condition_note || "").trim(), aspects, imageUrls: images,
              descriptionText: text, descriptionHtml: ebay.descriptionHtml(text),
              fulfillmentPolicyId, paymentPolicyId, returnPolicyId, locationKey, bestOffer,
            };
            if (preview) {
              const p = await ebay.prepareOffer(env, tok, L);
              if (p.error) return await fail(`${p.error} [at ${p.stage}]`, p.stage, p.offerId);
              const fees = await ebay.listingFees(env, tok, p.offerId);
              await db.prepare("UPDATE ebay_listings SET status='draft', offer_id=?, category_id=?, price_cents=?, best_offer_accept_cents=?, best_offer_decline_cents=?, error=NULL, updated_at=? WHERE id=?")
                .bind(p.offerId, String(b.category_id), Math.round(price * 100), bestOffer?.accept_cents ?? null, bestOffer?.decline_cents ?? null, now(), row.id).run();
              return J({ status: "preview", offer_id: p.offerId, fees: fees.error ? null : fees, fee_error: fees.error || null,
                         listing_credits: listingCredits(env), best_offer: bestOffer, returns });
            }
            const res = await ebay.publishListing(env, tok, L);
            if (res.error) return await fail(`${res.error} [at ${res.stage}]`, res.stage, res.offerId);
            await db.prepare("UPDATE ebay_listings SET status='published', offer_id=?, listing_id=?, listing_url=?, category_id=?, price_cents=?, best_offer_accept_cents=?, best_offer_decline_cents=?, funded_by=?, error=NULL, updated_at=? WHERE id=?")
              .bind(res.offerId, res.listingId, res.url, String(b.category_id), Math.round(price * 100), bestOffer?.accept_cents ?? null, bestOffer?.decline_cents ?? null, fundedBy, now(), row.id).run();
            await db.prepare("UPDATE items SET ai_title=?, price_cents=?, listing_status='live', listed_at=COALESCE(listed_at,?) WHERE id=?")
              .bind(title, Math.round(price * 100), now(), iid).run();
            return J({ status: "published", listing_id: res.listingId, url: res.url, warnings: res.warnings, credits_used: fundedBy ? 1 : 0, best_offer: bestOffer });
          } catch (e) {
            return await fail(String(e && e.message || e), "setup");
          }
        }

        // Live shipping quote (Shippo) for the box and weight the last estimate worked out.
        if (parts[3] === "shipping-quote" && m === "GET") {
          const ap = await db.prepare("SELECT result_json FROM appraisals WHERE item_id=? AND status='done' ORDER BY created_at DESC LIMIT 1").bind(iid).first();
          let est = null; try { est = ap?.result_json ? JSON.parse(ap.result_json).shipping : null; } catch {}
          try { return J(await quoteShipping(env, url.searchParams.get("from"), est, url.searchParams.get("service") === "priority" ? "priority" : "ground")); }
          catch (e) { return J({ error: String(e.message || e) }, e.status || 502); }
        }

        // Sold in person (scanned its sticker at a sale or the shop): record the price, take it off
        // eBay, and count it in the profit report. On a sale page it is marked sold there instead,
        // so the sale page and the report agree.
        if (parts[3] === "sold" && m === "POST") {
          const b = await readJson(request);
          const cents = Math.round(Number(String(b.price ?? "").replace(/[$,\s]/g, "")) * 100);
          if (!(cents >= 0 && cents < 1e9) || String(b.price ?? "").trim() === "") return J({ error: "Enter what it sold for, like 25 or 12.50" }, 400);
          if (item.listing_status === "sold") return J({ error: "This item is already marked sold." }, 409);
          const onEbaySold = await db.prepare("SELECT 1 FROM ebay_orders WHERE item_id=? AND status<>'CANCELLED' LIMIT 1").bind(iid).first();
          if (onEbaySold) return J({ error: "This item already sold on eBay." }, 409);
          const ts = now();
          const gi = await db.prepare("SELECT gi.sale_id FROM garage_sale_items gi JOIN garage_sales g ON g.id=gi.sale_id WHERE gi.item_id=? AND g.user_id=? AND gi.status<>'sold' ORDER BY (g.kind='shop'), (gi.status='pending') LIMIT 1").bind(iid, userId).first();
          if (gi) await db.prepare("UPDATE garage_sale_items SET status='sold', price_cents=?, sold_at=? WHERE item_id=? AND sale_id=?").bind(cents, ts, iid, gi.sale_id).run();
          else await db.prepare("INSERT INTO item_finance (item_id,user_id,sold_cents,sold_at,updated_at) VALUES (?,?,?,?,?) " +
                                "ON CONFLICT(item_id) DO UPDATE SET sold_cents=excluded.sold_cents, sold_at=excluded.sold_at, updated_at=excluded.updated_at")
            .bind(iid, userId, cents, ts, ts).run();
          await db.prepare("UPDATE items SET listing_status='sold' WHERE id=?").bind(iid).run();
          // Off the Market / any other sale page too, and off Etsy.
          await garage.pullOtherCopies(db, iid, gi ? gi.sale_id : "").run();
          await etsy.endEtsyListing(env, db, iid, "sold in person").catch(e => console.log("endEtsyListing", e));
          const eb = await ebayOrders.endEbayListing(env, db, iid, "sold in person");
          return J({ ok: true, sold_cents: cents, on_sale_page: !!gi, ebay: eb });
        }

        // What the seller paid for it (for the profit report). Blank clears it.
        if (parts[3] === "cost" && m === "PUT") {
          const b = await readJson(request);
          const raw = String(b.cost ?? "").replace(/[$,\s]/g, "");
          const c = raw === "" ? null : Math.round(Number(raw) * 100);
          if (c !== null && !(c >= 0 && c < 1e9)) return J({ error: "Enter what you paid, like 5 or 12.50" }, 400);
          await db.prepare("INSERT INTO item_finance (item_id,user_id,cost_cents,note,updated_at) VALUES (?,?,?,?,?) " +
                           "ON CONFLICT(item_id) DO UPDATE SET cost_cents=excluded.cost_cents, note=excluded.note, updated_at=excluded.updated_at")
            .bind(iid, userId, c, String(b.note || "").trim().slice(0, 120) || null, now()).run();
          return J({ cost_cents: c });
        }

        // Weight and box size for an item estimated before those existed. Free: one text call over
        // the stored identification, never a new appraisal. Only fills a gap — an estimate that
        // already has shipping returns it untouched, so repeated taps cost nothing.
        if (parts[3] === "shipping-estimate" && m === "POST") {
          const ap = await db.prepare("SELECT id, result_json FROM appraisals WHERE item_id=? AND status='done' ORDER BY created_at DESC LIMIT 1").bind(iid).first();
          let res = null; try { res = ap?.result_json ? JSON.parse(ap.result_json) : null; } catch {}
          if (!res) return J({ error: "estimate this item first" }, 409);
          if (res.shipping) return J({ shipping: res.shipping, cached: true });
          const it = await db.prepare("SELECT description, markings FROM items WHERE id=?").bind(iid).first();
          try {
            const shipping = await sizeOnly(env, { identification: res.identification, description: it?.description || "", markings: it?.markings || "" });
            res.shipping = shipping;
            await db.prepare("UPDATE appraisals SET result_json=? WHERE id=?").bind(JSON.stringify(res), ap.id).run();
            return J({ shipping, cached: false });
          } catch (e) { return J({ error: String(e.message || e) }, e.status || 502); }
        }

        if (parts[3] === "photos" && m === "POST") {
          const fd = await request.formData();
          const files = fd.getAll("photos").filter(f => typeof f === "object" && f.size);
          if (!files.length) return J({ error: "no photos" }, 400);
          const kinds = String(fd.get("kinds") || "").split(",").map(k => k.trim());
          const existing = await db.prepare("SELECT COUNT(*) AS n FROM photos WHERE item_id=?").bind(iid).first();
          if (existing.n + files.length > 12) return J({ error: "max 12 photos per item" }, 400);
          const out = [];
          for (let i = 0; i < files.length; i++) {
            const f = files[i];
            if (f.size > 10 * 1024 * 1024) return J({ error: `${f.name || "photo"} over 10 MB` }, 413);
            const ctype = f.type || "image/jpeg";
            const ext = ctype.includes("png") ? "png" : ctype.includes("webp") ? "webp" : ctype.includes("heic") ? "heic" : "jpg";
            const key = `${iid}/${uid()}.${ext}`;
            await env.PHOTOS.put(key, f.stream(), { httpMetadata: { contentType: ctype } });
            const kind = PHOTO_KINDS.has(kinds[i]) ? kinds[i] : "other";
            const id = uid();
            await db.prepare("INSERT INTO photos (id,item_id,r2_key,kind,content_type,bytes,sort,created_at) VALUES (?,?,?,?,?,?,?,?)")
              .bind(id, iid, key, kind, ctype, f.size, existing.n + i, now()).run();
            out.push({ id, kind, url: `/p/${key}` });
          }
          return J({ photos: out });
        }
        if (parts[3] === "appraise" && m === "POST") {
          const photos = (await db.prepare("SELECT * FROM photos WHERE item_id=? ORDER BY sort, created_at").bind(iid).all()).results;
          if (!photos.length) return J({ error: "add at least one photo first" }, 400);
          // Photographs alone are not enough. Four rolls of nickels stood on end were identified
          // five different ways across five runs — shotgun shells once, a 2023 Silver Eagle set
          // another time, which priced the lot at $260 when its silver alone was worth $585. One
          // line from the dealer settles what no amount of pixel-reading can. Checked here and
          // not only in the page, because the client is not the only way in.
          const b = await readJson(request).catch(() => ({}));
          // `dealer_description` — never `description`. The item page's description box is the
          // LISTING copy the model wrote, and it used to be posted here under the name this
          // endpoint reads as the dealer's own account, replacing "4 rolls of world war 2 silver
          // nickels" with a paragraph about a single modern nickel and pricing a $576 lot at
          // $1.42. Two endpoints meant opposite things by one word. Now they use two words, and
          // `description` is honoured here by nothing at all: an older cached client that still
          // sends it gets its re-run, and the dealer keeps what they wrote.
          if (b.description !== undefined) {
            console.log("appraise: ignoring legacy `description` field for item", iid);
            delete b.description;
          }
          if (!String(b.dealer_description ?? item.description ?? "").trim() &&
              !String(b.markings ?? item.markings ?? "").trim())
            return J({ error: "Tell us what it is, even roughly — a photo on its own is identified wrong too often.",
                       needs_description: true }, 400);
          if (!env.APPRAISER_URL && !env.NEBIUS_API_KEY) return J({ error: "appraiser not configured" }, 503);
          // Belt and braces on top of the rename: even under the new name, the model's own
          // listing copy is never accepted as what the dealer said. Losing a dealer's own words
          // cannot be undone, so this stays even though it should now be unreachable.
          if (b.dealer_description !== undefined && item.ai_description &&
              String(b.dealer_description).trim() === String(item.ai_description).trim()) {
            console.log("appraise: refused ai_description as dealer_description for item", iid);
            delete b.dealer_description;
          }
          if (b.dealer_description !== undefined || b.markings !== undefined) {
            await db.prepare("UPDATE items SET description=COALESCE(?,description), markings=COALESCE(?,markings) WHERE id=?")
              .bind(b.dealer_description ?? null, b.markings ?? null, iid).run();
            item.description = b.dealer_description ?? item.description; item.markings = b.markings ?? item.markings;
          }
          // metered: unlimited plan -> pro plan (300/mo) -> credits -> 402 with the paywall hint
          // Answering the questions on this item is part of the same estimate, so it is free:
          // the last run withheld its price to ask (needs_clarification). That follow-up then
          // either prices it or marks it unknown - it never asks again - so this can't repeat.
          // Derek, 2026-10-05, after a question loop cost 5 credits on one brass mouse.
          const lastAp = await db.prepare("SELECT status, result_json FROM appraisals WHERE item_id=? ORDER BY created_at DESC LIMIT 1").bind(iid).first();
          let followUp = false;
          try { const lr = lastAp?.status === "done" && lastAp.result_json ? JSON.parse(lastAp.result_json) : null; followUp = !!(lr && lr.needs_clarification && !lr.unknown); } catch {}
          const fundedBy = followUp ? null : await consumeEstimate(db, userId);
          if (!followUp && !fundedBy) return J({ error: "You're out of credits", paywall: true, plan: await planFor(db, userId) }, 402);
          const apId = uid();
          await db.prepare("INSERT INTO appraisals (id,item_id,status,created_at,funded_by) VALUES (?,?,'pending',?,?)").bind(apId, iid, now(), fundedBy).run();
          if (env.APPRAISALS) await env.APPRAISALS.send({ appraisalId: apId, itemId: iid });
          else ctx.waitUntil(runAppraisal(env, apId, item, photos));   // local dev without the queue binding
          return J({ appraisal_id: apId, status: "pending", funded_by: fundedBy }, 202);
        }
      }
      if (parts[1] === "photos" && parts.length === 3 && m === "DELETE") {
        const ph = await db.prepare("SELECT p.* FROM photos p JOIN items i ON i.id=p.item_id JOIN sales s ON s.id=i.sale_id WHERE p.id=? AND s.user_id=?").bind(parts[2], userId).first();
        if (!ph) return J({ error: "not found" }, 404);
        await env.PHOTOS.delete(ph.r2_key);
        await db.prepare("DELETE FROM photos WHERE id=?").bind(ph.id).run();
        return J({ deleted: 1 });
      }
      return J({ error: "not found" }, 404);
    } catch (e) {
      return J({ error: String(e && e.message || e) }, 500);
    }
  },

  // Every 15 minutes: read eBay orders for connected sellers, so a sale is noticed even when
  // nobody has the app open. At most 25 accounts a run, least recently read first.
  async scheduled(event, env, ctx) {
    const db = env.DB, origin = env.PUBLIC_ORIGIN || "https://app.theguestimator.com";
    const cutoff = new Date(Date.now() - 10 * 60e3).toISOString();
    const { results } = await db.prepare(
      "SELECT a.user_id FROM ebay_accounts a WHERE COALESCE(a.fulfillment_ok,1)<>0 AND (a.orders_synced_at IS NULL OR a.orders_synced_at < ?) " +
      "AND EXISTS (SELECT 1 FROM ebay_listings l WHERE l.user_id=a.user_id AND l.status='published') ORDER BY a.orders_synced_at LIMIT 25").bind(cutoff).all();
    for (const { user_id } of results) {
      try {
        // One retry for a dropped database connection ("D1_ERROR: Network connection lost"), which
        // otherwise showed up as a failure on the owner page although the next run (15 min) was fine.
        let r;
        try { r = await ebayOrders.syncOrders(env, db, user_id); }
        catch (e) {
          if (!transientD1(e)) throw e;
          await new Promise(res => setTimeout(res, 1500));
          r = await ebayOrders.syncOrders(env, db, user_id);
        }
        for (const id of r.new || []) await ebaySoldAlert(db, env, id, origin).catch(e => console.log("ebaySoldAlert", e));
      } catch (e) { await owner.opsFail(db, "ebay order sync failed", e); console.log("ebay order sync failed", user_id, String(e && e.message || e)); }
    }
    // Etsy cross-listings: a sale there ends the eBay copy and emails the seller.
    try {
      const sold = await etsy.pollSold(env, db, origin);
      if (sold.length) console.log("etsy poll", JSON.stringify(sold));
    } catch (e) { await owner.opsFail(db, "etsy poll failed", e); console.log("etsy poll failed", String(e && e.message || e)); }
    // Price-drop nudges, after the order read so a listing that just sold is not nudged.
    try { await nudges.emailNudges(env, db, origin); } catch (e) { await owner.opsFail(db, "price nudges failed", e); console.log("price nudges failed", String(e && e.message || e)); }
    // Labels paid for by card where the seller never came back from Stripe: buy them now.
    if (labelpay.payOn(env)) {
      try {
        const buyFor = uid => row => labels.buyLabel(env, db, uid, row.kind, row.order_id, row.rate_id, row.label_cents, row.file_type, origin, ctx, buyerShippedEmail);
        const done = await labelpay.sweep(env, db, garage.stripe, buyFor);
        if (done.length) console.log("label sweep", JSON.stringify(done.map(d => ({ id: d.id, status: d.status, error: d.error }))));
      } catch (e) { await owner.opsFail(db, "label sweep failed", e); console.log("label sweep failed", String(e && e.message || e)); }
    }
    // Shipping ops: follow voids, ship-by reminders, money-safety alerts to the house.
    try { await shipops.checkVoids(env, db, shipEnvFor(env, db), garage.stripe); } catch (e) { await owner.opsFail(db, "void check failed", e); console.log("void check failed", String(e && e.message || e)); }
    try { await shipops.shipReminders(env, db, origin); } catch (e) { await owner.opsFail(db, "ship reminders failed", e); console.log("ship reminders failed", String(e && e.message || e)); }
    try { await shipops.moneyAlerts(env, db); } catch (e) { await owner.opsFail(db, "money alerts failed", e); console.log("money alerts failed", String(e && e.message || e)); }
    // eBay returns / not-received / cases (and buyer messages when that scope is on).
    try { await ebaycare.careSweep(env, db, origin); } catch (e) { await owner.opsFail(db, "ebay care failed", e); console.log("ebay care failed", String(e && e.message || e)); }
    // Referral rewards (after a referred seller's first purchase) and win-back reminders.
    try { await growth.rewardSweep(env, db, origin); } catch (e) { await owner.opsFail(db, "referral rewards failed", e); console.log("referral rewards failed", String(e && e.message || e)); }
    try { await growth.winbackSweep(env, db, origin); } catch (e) { await owner.opsFail(db, "winback failed", e); console.log("winback failed", String(e && e.message || e)); }
    // Monday selling summary (no-op outside the window; once a week per seller).
    try { await weekly.emailWeekly(env, db, origin); } catch (e) { await owner.opsFail(db, "weekly summary failed", e); console.log("weekly summary failed", String(e && e.message || e)); }
  },

  // An appraisal takes ~2 minutes of waiting on Token Factory. ctx.waitUntil() only buys 30s after the
  // response, so the old fire-and-forget would have been killed mid-run — leaving the row 'pending'
  // forever and silently eating the dealer's estimate. A queue consumer gets the time it needs.
  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        const { appraisalId, itemId } = msg.body;
        const ap = await env.DB.prepare("SELECT status FROM appraisals WHERE id=?").bind(appraisalId).first();
        if (!ap || ap.status !== "pending") { msg.ack(); continue; }   // already done, or gone
        const item = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(itemId).first();
        if (!item) { msg.ack(); continue; }
        const photos = (await env.DB.prepare("SELECT * FROM photos WHERE item_id=? ORDER BY sort, created_at").bind(itemId).all()).results;
        await runAppraisal(env, appraisalId, item, photos);
        msg.ack();
      } catch (e) {
        // runAppraisal already records its own failures and refunds; this is for anything outside it.
        msg.retry();
      }
    }
  }
};

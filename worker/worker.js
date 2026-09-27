// Guestimator — API worker: accounts, items, photos (R2), AI estimates (Nebius), and listing on the
// user's own eBay account. Runs first for /api/* and /p/* (photos); everything else is static assets.
// Split from Bottle Tree (bottletree-appraiser) on 2026-09-27; the POS lives on there.
import { planFor, consumeEstimate, refundEstimate, applyRevenueCatEvent } from "./billing.js";
// New Guestimator accounts start with nothing: every estimate is bought. Accounts that already
// exist (including Bottle Tree ones signing in here) keep whatever balance they have.
const SIGNUP_CREDITS = 0;
import { appraise } from "./appraiser.js";
import * as ebay from "./ebay.js";
// Every Guestimator item lives in one hidden per-user `sales` row (the schema is Bottle Tree's).
const GUESS_BUCKET = "Guestimator";
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

async function itemBundle(db, itemId) {
  const item = await db.prepare("SELECT * FROM items WHERE id=?").bind(itemId).first();
  if (!item) return null;
  const photos = (await db.prepare("SELECT * FROM photos WHERE item_id=? ORDER BY sort, created_at").bind(itemId).all()).results;
  const ap = await db.prepare("SELECT * FROM appraisals WHERE item_id=? ORDER BY created_at DESC LIMIT 1").bind(itemId).first();
  let appraisal = null;
  if (ap) appraisal = { id: ap.id, status: ap.status, error: ap.error, created_at: ap.created_at, completed_at: ap.completed_at,
                        result: ap.result_json ? JSON.parse(ap.result_json) : null };
  const el = await db.prepare("SELECT status, listing_url, listing_id, error, updated_at FROM ebay_listings WHERE item_id=? ORDER BY created_at DESC LIMIT 1").bind(itemId).first();
  return { item, photos: photos.map(p => ({ ...p, url: `/p/${p.r2_key}` })), appraisal, ebay: el || null };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const db = env.DB;
    const parts = p.split("/").filter(Boolean);
    const m = request.method;
    try {
      // ---------- PUBLIC: photos from R2 ----------
      if (parts[0] === "p" && parts.length >= 2 && m === "GET") {
        const obj = await env.PHOTOS.get(parts.slice(1).join("/"));
        if (!obj) return new Response("not found", { status: 404 });
        return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType || "image/jpeg", "cache-control": "public, max-age=31536000, immutable", etag: obj.httpEtag } });
      }
      if (!p.startsWith("/api/")) return env.ASSETS.fetch(request);

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
      if (parts[1] === "ebay" && parts[2] === "deletion") {
        if (!env.EBAY_VERIFY_TOKEN || !env.EBAY_DELETION_URL)
          return J({ error: "deletion endpoint not configured" }, 503);
        if (m === "GET") {
          const challenge = url.searchParams.get("challenge_code");
          if (!challenge) return J({ error: "challenge_code required" }, 400);
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(challenge + env.EBAY_VERIFY_TOKEN + env.EBAY_DELETION_URL));
          const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
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
        const page = (title, msg, ok) => H(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#F4ECDC;color:#241B10;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px}
.c{background:#FBF6EA;border:1px solid #E0D2B4;border-radius:14px;padding:22px;max-width:420px;text-align:center}.c h1{font-size:1.3rem;margin:0 0 8px}
.ok{color:#0F6B59}.bad{color:#B4552B}a{display:inline-block;margin-top:14px;background:#0F6B59;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700}</style></head>
<body><div class="c"><h1 class="${ok ? "ok" : "bad"}">${esc(title)}</h1><p>${esc(msg)}</p><a href="/">Back to Guestimator</a></div></body></html>`, ok ? 200 : 400, "no-store");
        const state = url.searchParams.get("state") || "";
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
            "access_expires_at=excluded.access_expires_at, updated_at=excluded.updated_at")
            .bind(st.user_id, who.userId, who.username, await ebay.seal(env, tok.refresh_token), refreshExp,
                  await ebay.seal(env, tok.access_token), new Date(Date.now() + (tok.expires_in || 7200) * 1000).toISOString(), ts, ts).run();
          return page("eBay connected", `Guestimator can now list items on ${who.username ? `the eBay account ${who.username}` : "your eBay account"}. Nothing is listed until you review it and tap List.`, true);
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
          // Guestimator has no free estimate (Derek, 2026-09-27). users.credits defaults to 1 in
          // the shared schema because Bottle Tree still grants one, so 0 is written explicitly -
          // and no welcome row, so the ledger still accounts for exactly what the wallet holds.
          await db.prepare("INSERT INTO users (id,email,pw_hash,pw_salt,created_at,credits) VALUES (?,?,?,?,?,?)")
            .bind(id, email, h, salt, ts, SIGNUP_CREDITS).run();
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
          return J({ email }, 200, { "Set-Cookie": sessionCookie(await newSession(db, u.id)) });
        }
        if (act === "google" && m === "POST") {
          if (!env.GOOGLE_CLIENT_ID) return J({ error: "Google sign-in is not configured" }, 503);
          const b = await readJson(request);
          let g;
          try { g = await verifyGoogleIdToken(b.credential, env.GOOGLE_CLIENT_ID); }
          catch (e) { return J({ error: "Could not verify that Google sign-in" }, 401); }
          // Match on sub first (email can change), then fall back to email to link an existing password account.
          let u = await db.prepare("SELECT * FROM users WHERE google_sub=?").bind(g.sub).first();
          if (!u) {
            u = await db.prepare("SELECT * FROM users WHERE email=?").bind(g.email).first();
            if (u) await db.prepare("UPDATE users SET google_sub=? WHERE id=?").bind(g.sub, u.id).run();
          }
          if (!u) {
            const id = uid(), ts = now();
            // Same opening balance (none) whichever door they came in by.
            await db.prepare("INSERT INTO users (id,email,pw_hash,pw_salt,google_sub,created_at,credits) VALUES (?,?,'','',?,?,?)")
              .bind(id, g.email, g.sub, ts, SIGNUP_CREDITS).run();
            u = { id, email: g.email };
          }
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
          return J(u || {});
        }
        // Public: the web client ID is not a secret; the app needs it to render the Google button.
        if (act === "config" && m === "GET")
          return J({ google_client_id: env.GOOGLE_CLIENT_ID || null });
        return J({ error: "not found" }, 404);
      }

      // ---------- everything below requires a session ----------
      const userId = await currentUser(request, db);
      if (!userId) return J({ error: "not authenticated" }, 401);
      const ownsSale = async (sid) => !!(await db.prepare("SELECT id FROM sales WHERE id=? AND user_id=?").bind(sid, userId).first());
      const ownsItem = async (iid) => await db.prepare("SELECT i.* FROM items i JOIN sales s ON s.id=i.sale_id WHERE i.id=? AND s.user_id=?").bind(iid, userId).first();

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
          const state = randHex(24);
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
        if (parts.length === 3 && m === "DELETE") {
          if (item.status !== "available") return J({ error: "sold items can't be deleted" }, 400);
          const ps = (await db.prepare("SELECT r2_key FROM photos WHERE item_id=?").bind(iid).all()).results;
          await Promise.all(ps.map(x => env.PHOTOS.delete(x.r2_key)));
          await db.prepare("DELETE FROM photos WHERE item_id=?").bind(iid).run();
          await db.prepare("DELETE FROM appraisals WHERE item_id=?").bind(iid).run();
          const r = await db.prepare("DELETE FROM items WHERE id=?").bind(iid).run();
          return J({ deleted: r.meta.changes });
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
          const draft = await ebay.buildDraft(env, { item, photos: bundle.photos, result: bundle.appraisal.result,
                                                     origin: env.PUBLIC_ORIGIN || url.origin, categoryId: db0.category_id });
          const ts = now();
          if (last) await db.prepare("UPDATE ebay_listings SET draft_json=?, category_id=?, updated_at=? WHERE id=?")
            .bind(JSON.stringify(draft), draft.category?.id || null, ts, last.id).run();
          else await db.prepare("INSERT INTO ebay_listings (id,item_id,user_id,sku,status,category_id,draft_json,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?,?,?)")
            .bind(uid(), iid, userId, ebay.skuFor(iid), draft.category?.id || null, JSON.stringify(draft), ts, ts).run();
          return J({ draft, listing: last ? { status: last.status, error: last.error } : { status: "draft" } });
        }

        // ---------- eBay: publish the reviewed draft to the user's own account ----------
        if (parts[3] === "ebay" && parts[4] === "publish" && m === "POST") {
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
          if (!row) {
            row = { id: uid(), offer_id: null };
            await db.prepare("INSERT INTO ebay_listings (id,item_id,user_id,sku,status,created_at,updated_at) VALUES (?,?,?,?,'publishing',?,?)")
              .bind(row.id, iid, userId, ebay.skuFor(iid), ts, ts).run();
          } else await db.prepare("UPDATE ebay_listings SET status='publishing', error=NULL, updated_at=? WHERE id=?").bind(ts, row.id).run();

          const credits = listingCredits(env);
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
            if (!fulfillmentPolicyId) fulfillmentPolicyId = await ebay.createFulfillmentPolicy(env, tok, b.shipping_cost, b.handling_days);
            const paymentPolicyId = pol.payment[0]?.id || await ebay.createPaymentPolicy(env, tok);
            const returnPolicyId = (pol.return.some(p => p.id === b.return_policy_id) ? b.return_policy_id : pol.return[0]?.id)
              || await ebay.createReturnPolicy(env, tok);
            const locationKey = await ebay.ensureLocation(env, tok, zip);
            const text = String(b.description).trim();
            const res = await ebay.publishListing(env, tok, {
              sku: ebay.skuFor(iid), offerId: row.offer_id, title, price, categoryId: b.category_id, condition,
              conditionDescription: String(b.condition_note || "").trim(), aspects, imageUrls: images,
              descriptionText: text, descriptionHtml: ebay.descriptionHtml(text),
              fulfillmentPolicyId, paymentPolicyId, returnPolicyId, locationKey,
            });
            if (res.error) return await fail(res.error, res.stage, res.offerId);
            await db.prepare("UPDATE ebay_listings SET status='published', offer_id=?, listing_id=?, listing_url=?, category_id=?, price_cents=?, funded_by=?, error=NULL, updated_at=? WHERE id=?")
              .bind(res.offerId, res.listingId, res.url, String(b.category_id), Math.round(price * 100), fundedBy, now(), row.id).run();
            await db.prepare("UPDATE items SET ai_title=?, price_cents=?, listing_status='live', listed_at=COALESCE(listed_at,?) WHERE id=?")
              .bind(title, Math.round(price * 100), now(), iid).run();
            return J({ status: "published", listing_id: res.listingId, url: res.url, warnings: res.warnings, credits_used: fundedBy ? 1 : 0 });
          } catch (e) {
            return await fail(String(e && e.message || e), "setup");
          }
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
          const fundedBy = await consumeEstimate(db, userId);
          if (!fundedBy) return J({ error: "You're out of estimates", paywall: true, plan: await planFor(db, userId) }, 402);
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

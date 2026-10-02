// Sellers' own Shippo accounts (Shippo "gray label" OAuth). Each seller connects the Shippo
// account they already have (or makes one on the way through), and every label they buy in
// Guestimator is billed by Shippo to them. The token Shippo returns does not expire; it is kept
// sealed with the same key as eBay tokens. Needs Guestimator's Shippo partner id and secret
// (SHIPPO_OAUTH_CLIENT_ID / SHIPPO_OAUTH_CLIENT_SECRET), which Shippo issues on approval; until
// then connecting is switched off and only LABEL_USERS (Derek, on the house account) buy labels.

import { seal, unseal } from "./ebay.js";

const enc = new TextEncoder();
export const oauthReady = env => !!(env.SHIPPO_OAUTH_CLIENT_ID && env.SHIPPO_OAUTH_CLIENT_SECRET && env.EBAY_TOKEN_KEY);

async function hmac(env, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode("shippo-state:" + env.EBAY_TOKEN_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)))].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
// state = userId.timestamp.signature: ties the callback to who started it, for 30 minutes.
export async function makeState(env, userId, nowMs = Date.now()) { const t = String(nowMs); return `${userId}.${t}.${await hmac(env, userId + "." + t)}`; }
export async function readState(env, state, nowMs = Date.now()) {
  const [u, t, sig] = String(state || "").split(".");
  if (!u || !t || !sig || nowMs - Number(t) > 30 * 60e3 || nowMs < Number(t) - 60e3) return null;
  return sig === await hmac(env, u + "." + t) ? u : null;
}
export const authorizeUrl = (env, state) =>
  `https://goshippo.com/oauth/authorize?response_type=code&client_id=${encodeURIComponent(env.SHIPPO_OAUTH_CLIENT_ID)}&scope=*&state=${encodeURIComponent(state)}`;

export async function exchange(env, code) {
  const r = await fetch("https://goshippo.com/oauth/access_token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.SHIPPO_OAUTH_CLIENT_ID, client_secret: env.SHIPPO_OAUTH_CLIENT_SECRET, code: String(code || ""), grant_type: "authorization_code" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || `Shippo said ${r.status}`);
  return j.access_token;
}

export async function saveToken(env, db, userId, token, nowMs = Date.now()) {
  const ts = new Date(nowMs).toISOString();
  await db.prepare("INSERT INTO seller_settings (user_id, shippo_token_enc, shippo_connected_at, updated_at) VALUES (?,?,?,?) " +
                   "ON CONFLICT(user_id) DO UPDATE SET shippo_token_enc=excluded.shippo_token_enc, shippo_connected_at=excluded.shippo_connected_at, updated_at=excluded.updated_at")
    .bind(userId, await seal(env, token), ts, ts).run();
}
export async function disconnect(db, userId) {
  await db.prepare("UPDATE seller_settings SET shippo_token_enc=NULL, shippo_connected_at=NULL WHERE user_id=?").bind(userId).run();
}

/**
 * Whose Shippo account pays for this seller's labels: their own (connected), else the house
 * account for LABEL_USERS, else nobody. Returns an env to hand to labels.js, or null.
 */
export async function labelEnv(env, db, userId, houseOk) {
  const s = await db.prepare("SELECT shippo_token_enc FROM seller_settings WHERE user_id=?").bind(userId).first();
  if (s?.shippo_token_enc) {
    const tok = await unseal(env, s.shippo_token_enc).catch(() => null);
    if (tok) return { env: { ...env, SHIPPO_AUTH: `Bearer ${tok}` }, payer: "seller" };
  }
  if (houseOk) return { env, payer: "house" };
  return null;
}
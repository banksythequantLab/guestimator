// Growth: seller referral links and win-back emails.
//
// Referrals: every seller has a personal link (?ref=CODE). A friend who signs up through it and
// then makes a first REAL purchase (RevenueCat, not sandbox, not a promo) earns both of them
// REFERRAL_CREDITS free credits (default 5). Nothing is granted for a sign-up alone, so fake
// accounts earn nothing. The purchase is read from billing_events (whichever worker wrote it),
// so this works while the RevenueCat webhook still points at the Bottle Tree worker.
//
// Win-back: two emails, each at most once, only to Guestimator accounts (gs_users), with a
// one-click unsubscribe: (1) signed up 3+ days ago and never priced anything; (2) used it, went
// quiet for 30+ days, and still has priced items that aren't listed.

import { sendAlert } from "./notify.js";
import { freeCreditsLine } from "./onboard.js";

const enc = new TextEncoder();
const DAY = 86400e3;
const iso = ms => new Date(ms).toISOString();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const refCredits = env => Math.max(0, Math.floor(Number(env.REFERRAL_CREDITS ?? 5)));
export const refMaxPerMonth = env => Math.max(0, Math.floor(Number(env.REFERRAL_MAX_PER_MONTH ?? 20)));
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I/L
export const newCode = () => [...crypto.getRandomValues(new Uint8Array(7))].map(b => ALPHA[b % ALPHA.length]).join("");
export const cleanCode = c => String(c || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);

// A real first purchase: RevenueCat, a purchase type, not the store sandbox.
export const PURCHASE_SQL = "b.source='revenuecat' AND b.type IN ('INITIAL_PURCHASE','NON_RENEWING_PURCHASE') AND COALESCE(b.raw_json,'') NOT LIKE '%\"environment\":\"SANDBOX\"%'";

export async function codeFor(db, userId, ms = Date.now()) {
  const had = await db.prepare("SELECT code FROM ref_codes WHERE user_id=?").bind(userId).first();
  if (had) return had.code;
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const r = await db.prepare("INSERT OR IGNORE INTO ref_codes (user_id, code, created_at) VALUES (?,?,?)").bind(userId, code, iso(ms)).run();
    if (r.meta && r.meta.changes) return code;
    const again = await db.prepare("SELECT code FROM ref_codes WHERE user_id=?").bind(userId).first();
    if (again) return again.code;   // another request made it first
  }
  throw new Error("couldn't make a referral code");
}

export async function referralInfo(env, db, userId, origin) {
  const code = await codeFor(db, userId);
  const s = await db.prepare("SELECT COUNT(*) joined, SUM(rewarded_at IS NOT NULL) rewarded FROM referrals WHERE referrer_id=?").bind(userId).first();
  const by = await db.prepare("SELECT 1 FROM referrals WHERE referee_id=?").bind(userId).first();
  return { code, link: `${origin}/?ref=${code}`, credits: refCredits(env), joined: Number(s?.joined || 0), rewarded: Number(s?.rewarded || 0), was_referred: !!by };
}

export const CLAIM_WINDOW_H = 48;   // a referral link only counts for an account this new

/** A new account says who sent it. Once per account, never yourself, only for fresh accounts. */
export async function claim(db, refereeId, rawCode, ms = Date.now()) {
  const code = cleanCode(rawCode);
  const owner = code && await db.prepare("SELECT user_id FROM ref_codes WHERE code=?").bind(code).first();
  if (!owner) return { status: 404, error: "That invite link isn't valid." };
  if (owner.user_id === refereeId) return { status: 400, error: "That's your own invite link." };
  const me = await db.prepare("SELECT created_at FROM users WHERE id=?").bind(refereeId).first();
  if (!me || ms - Date.parse(me.created_at) > CLAIM_WINDOW_H * 3600e3) return { status: 409, error: "Invite links are for new accounts." };
  const bought = await db.prepare(`SELECT 1 FROM billing_events b WHERE b.user_id=? AND ${PURCHASE_SQL}`).bind(refereeId).first();
  if (bought) return { status: 409, error: "Invite links are for new accounts." };
  const r = await db.prepare("INSERT OR IGNORE INTO referrals (referee_id, referrer_id, code, created_at) VALUES (?,?,?,?)").bind(refereeId, owner.user_id, code, iso(ms)).run();
  if (!(r.meta && r.meta.changes)) return { status: 409, error: "This account already has an invite." };
  return { status: 200, ok: true };
}

/** Cron: reward referrals whose new seller has made a first real purchase. Both sides, once. */
export async function rewardSweep(env, db, origin, ms = Date.now()) {
  const credits = refCredits(env);
  if (!credits) return [];
  const { results } = await db.prepare(
    `SELECT r.*, ue.email referee_email, ur.email referrer_email FROM referrals r JOIN users ue ON ue.id=r.referee_id JOIN users ur ON ur.id=r.referrer_id
      WHERE r.rewarded_at IS NULL AND EXISTS (SELECT 1 FROM billing_events b WHERE b.user_id=r.referee_id AND ${PURCHASE_SQL} AND b.created_at>=r.created_at)
      LIMIT 25`).all();
  const out = [], monthStart = iso(Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), 1));
  for (const r of results || []) {
    const used = await db.prepare("SELECT COUNT(*) n FROM billing_events WHERE source='referral' AND type='referrer' AND user_id=? AND created_at>=?").bind(r.referrer_id, monthStart).first();
    const payReferrer = Number(used?.n || 0) < refMaxPerMonth(env);
    const grant = (userId, type) => [
      db.prepare("INSERT INTO billing_events (id,user_id,source,event_id,type,product_id,credits_delta,created_at) VALUES (?,?,'referral',?,?,?,?,?)")
        .bind(crypto.randomUUID(), userId, `ref:${r.referee_id}:${type}`, type, r.code, credits, iso(ms)),
      db.prepare("UPDATE users SET credits=credits+? WHERE id=?").bind(credits, userId)];
    try {
      await db.batch([
        db.prepare("UPDATE referrals SET rewarded_at=? WHERE referee_id=? AND rewarded_at IS NULL").bind(iso(ms), r.referee_id),
        ...grant(r.referee_id, "referee"), ...(payReferrer ? grant(r.referrer_id, "referrer") : [])]);
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e && e.message))) { out.push({ referee: r.referee_id, skipped: "already rewarded" }); continue; }
      throw e;
    }
    await sendAlert(env, { to: r.referee_email, subject: `${credits} free Guestimator credits - thanks for joining`,
      text: `You joined through a friend's invite, so ${credits} free credits are in your account now.\n\n${origin}/` });
    if (payReferrer) await sendAlert(env, { to: r.referrer_email, subject: `Your invite worked: ${credits} free credits`,
      text: `Someone you invited just made their first purchase on Guestimator, so ${credits} free credits are in your account now.\n\nInvite more people from the app: ${origin}/` });
    out.push({ referee: r.referee_id, referrer_paid: payReferrer });
  }
  return out;
}

// ---------------------------------------------------------------- win-back

export const markGsUser = (db, userId, ms = Date.now()) =>
  db.prepare("INSERT OR IGNORE INTO gs_users (user_id, created_at) VALUES (?,?)").bind(userId, iso(ms)).run();

async function sign(env, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode("mkt-off:" + String(env.EBAY_TOKEN_KEY || env.SESSION_KEY || "guestimator")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)))].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
export const offLink = async (env, origin, userId) => `${origin}/api/growth/off?u=${encodeURIComponent(userId)}&t=${await sign(env, userId)}`;
export const offTokenOk = async (env, userId, t) => !!userId && typeof t === "string" && t === await sign(env, userId);
export const turnOff = (db, userId) => db.prepare("UPDATE gs_users SET marketing_off=1 WHERE user_id=?").bind(userId).run();

export const W1_AFTER_D = 3, W1_UNTIL_D = 30, W2_QUIET_D = 30, W2_AGAIN_D = 90;
const OWNED = "FROM appraisals a JOIN items i ON i.id=a.item_id JOIN sales s ON s.id=i.sale_id WHERE s.user_id=g.user_id";

function mail(title, lines, link, linkText, off) {
  const text = [title, "", ...lines, "", link, "", `Don't want these? ${off}`].join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f4ecdc;margin:0;padding:24px;color:#241b10">
<div style="max-width:520px;margin:0 auto;background:#fbf6ea;border:1px solid #e0d2b4;border-radius:14px;padding:22px">
<div style="font-weight:800;font-size:19px;margin-bottom:10px">${esc(title)}</div>${lines.map(l => `<p style="font-size:14px;margin:8px 0">${esc(l)}</p>`).join("")}
<a href="${esc(link)}" style="display:inline-block;margin-top:8px;background:#241b10;color:#f4ecdc;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:10px">${esc(linkText)}</a>
<div style="margin-top:16px;font-size:12px;color:#6a5b44"><a href="${esc(off)}" style="color:#6a5b44">Unsubscribe</a> from these reminders. Sale alerts still come.</div></div></body></html>`;
  return { text, html };
}

// Free estimates for new accounts (same rule as worker.js signupCredits) and the demo Short.
const freeN = env => { const n = Number(env.SIGNUP_CREDITS ?? 5); return Number.isFinite(n) && n > 0 ? Math.min(20, Math.floor(n)) : 0; };
const demoUrl = env => /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(String(env.DEMO_VIDEO_URL || "")) ? env.DEMO_VIDEO_URL : null;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ---------- one-time win-back with free estimates (owner button, 2026-10-05) ----------
// Everyone who signed up before estimates were free hit "buy credits" on their first try; the
// automatic first-estimate email then sent them back to the same wall. This tops each of them up
// to the free amount and says so, once. The billing_events row (type 'winback_free') is both the
// ledger entry and the once-only marker.
// Accounts made since 2026-10-05 got their free estimates at sign-up ('signup_free'): not for this.
const NO_WINBACK = "NOT EXISTS (SELECT 1 FROM billing_events b WHERE b.user_id=g.user_id AND b.type IN ('winback_free','signup_free'))";
export async function winbackCandidates(env, db, ownerEmail) {
  return (await db.prepare(
    `SELECT g.user_id, u.email, u.credits, g.created_at, g.winback1_at FROM gs_users g JOIN users u ON u.id=g.user_id
      WHERE COALESCE(g.marketing_off,0)=0 AND NOT EXISTS (SELECT 1 ${OWNED}) AND ${NO_WINBACK} AND lower(u.email)<>lower(?)
      ORDER BY g.created_at DESC LIMIT 100`).bind(String(ownerEmail || "")).all()).results || [];
}
export async function winbackFree(env, db, origin, ownerEmail, { only = null, ms = Date.now() } = {}) {
  const n = freeN(env);
  if (!n) return { sent: 0, error: "free estimates are switched off (SIGNUP_CREDITS=0)" };
  let list = await winbackCandidates(env, db, ownerEmail);
  if (Array.isArray(only)) list = list.filter(c => only.includes(c.user_id));
  const done = [];
  for (const c of list) {
    const top = Math.max(0, n - Number(c.credits || 0));
    // Marker first: if two clicks race, only one of them inserts it.
    const ins = await db.prepare(`INSERT INTO billing_events (id,user_id,source,type,credits_delta,raw_json,created_at)
        SELECT ?,?,'admin','winback_free',?,?,? WHERE NOT EXISTS (SELECT 1 FROM billing_events WHERE user_id=? AND type='winback_free')`)
      .bind(crypto.randomUUID(), c.user_id, top, JSON.stringify({ reason: "free estimates for an account that signed up before they existed" }), iso(ms), c.user_id).run();
    if (!(ins.meta && ins.meta.changes)) continue;
    await db.batch([
      db.prepare("UPDATE users SET credits=COALESCE(credits,0)+? WHERE id=?").bind(top, c.user_id),
      db.prepare("UPDATE gs_users SET winback1_at=COALESCE(winback1_at,?) WHERE user_id=?").bind(iso(ms), c.user_id),
    ]);
    const have = Number(c.credits || 0) + top;
    const r = await mailWinback(env, db, origin, c.user_id, c.email, have);
    done.push({ user: c.user_id, added: top, emailed: r.sent, why: r.sent ? undefined : r.why });
  }
  // "sent" counts emails that actually went: Cloudflare refused every address that wasn't verified
  // in the account and the old count still said 5 (2026-10-05).
  return { credited: done.length, sent: done.filter(d => d.emailed).length, failed: done.filter(d => !d.emailed).map(d => ({ user: d.user, why: d.why })), done };
}
// Sends the win-back email and records on its ledger row whether it went, so a failed one can be resent.
async function mailWinback(env, db, origin, userId, email, have) {
  const e = winbackFreeMail(env, origin, have, await offLink(env, origin, userId));
  const r = await sendAlert(env, { to: email, subject: `Your ${plural(have, "free credit")} ${have === 1 ? "is" : "are"} ready`, ...e });
  await db.prepare("UPDATE billing_events SET raw_json=json_set(COALESCE(raw_json,'{}'),'$.emailed',json(?),'$.email_error',?) WHERE user_id=? AND type='winback_free'")
    .bind(r.sent ? "true" : "false", r.sent ? null : String(r.why || "").slice(0, 200), userId).run();
  return r;
}
// People who got the win-back credits but whose email didn't go (or was never confirmed), and still
// haven't priced anything or unsubscribed.
export async function winbackUnsent(db) {
  return (await db.prepare(
    `SELECT g.user_id, u.email, u.credits, b.created_at, json_extract(b.raw_json,'$.email_error') why
       FROM billing_events b JOIN gs_users g ON g.user_id=b.user_id JOIN users u ON u.id=b.user_id
      WHERE b.type='winback_free' AND COALESCE(json_extract(b.raw_json,'$.emailed'),0)<>1
        AND COALESCE(g.marketing_off,0)=0 AND NOT EXISTS (SELECT 1 ${OWNED}) ORDER BY b.created_at DESC LIMIT 100`).all()).results || [];
}
export async function winbackResend(env, db, origin, ids) {
  const list = (await winbackUnsent(db)).filter(c => ids.includes(c.user_id));
  const out = [];
  for (const c of list) { const r = await mailWinback(env, db, origin, c.user_id, c.email, Number(c.credits || 0)); out.push({ user: c.user_id, emailed: r.sent, why: r.why }); }
  return { sent: out.filter(o => o.emailed).length, failed: out.filter(o => !o.emailed), done: out };
}
export function winbackFreeMail(env, origin, have, off) {
  const demo = demoUrl(env);
  return mail(`Your ${plural(have, "free credit")} ${have === 1 ? "is" : "are"} ready`, [
    "You made a Guestimator account but haven't priced anything yet. Back then, every estimate cost a credit from the very first one.",
    `Now you start with ${freeCreditsLine(have)}. They're already in your account.`,
    "Pick something you'd like to sell, snap 2-4 photos, and get a price from what's actually selling on eBay right now - plus the box and weight to ship it.",
    ...(demo ? [`See it work in 30 seconds: ${demo}`] : [])],
    `${origin}/`, "Guestimate something", off);
}

// Sign-ups by week and how far each week's people got. Guestimator accounts only (gs_users).
export async function funnelByWeek(db, ms = Date.now(), weeks = 8) {
  return (await db.prepare(
    `SELECT strftime('%Y-%W', g.created_at) wk, MIN(substr(g.created_at,1,10)) first_day, COUNT(*) signed,
        SUM(EXISTS (SELECT 1 ${OWNED})) estimated,
        SUM(EXISTS (SELECT 1 FROM ebay_listings l WHERE l.user_id=g.user_id AND l.listing_id IS NOT NULL)) listed,
        SUM(EXISTS (SELECT 1 FROM ebay_orders o WHERE o.user_id=g.user_id AND o.status<>'CANCELLED')) sold,
        SUM(EXISTS (SELECT 1 FROM billing_events b WHERE b.user_id=g.user_id AND ${PURCHASE_SQL})) paid
      FROM gs_users g WHERE g.created_at>=? GROUP BY wk ORDER BY wk DESC`).bind(iso(ms - weeks * 7 * DAY)).all()).results || [];
}

/** Cron: at most 25 of each email per run; each person gets each email once (W2: once per 90 days). */
export async function winbackSweep(env, db, origin, ms = Date.now()) {
  const sent = [];
  const w1 = (await db.prepare(
    `SELECT g.user_id, u.email, u.credits FROM gs_users g JOIN users u ON u.id=g.user_id
      WHERE g.winback1_at IS NULL AND COALESCE(g.marketing_off,0)=0 AND g.created_at<=? AND g.created_at>=? AND NOT EXISTS (SELECT 1 ${OWNED})
        ${freeN(env) ? `AND (COALESCE(u.credits,0)>0 OR NOT ${NO_WINBACK})` : ""} LIMIT 25`)
    .bind(iso(ms - W1_AFTER_D * DAY), iso(ms - W1_UNTIL_D * DAY)).all()).results || [];
  for (const g of w1) {
    const m = await db.prepare("UPDATE gs_users SET winback1_at=? WHERE user_id=? AND winback1_at IS NULL").bind(iso(ms), g.user_id).run();
    if (!(m.meta && m.meta.changes)) continue;
    // Says what's in their account: "price your first thing" to someone with no credits sent them
    // straight to the buy-credits wall (2026-10-05).
    const have = Number(g.credits || 0), demo = demoUrl(env);
    const e = mail("What's in your closet worth?", ["You made a Guestimator account but haven't priced anything yet.",
      ...(have > 0 ? [`You have ${freeCreditsLine(have)} waiting in your account.`] : []),
      "Pick one thing you've been meaning to sell, snap 2-4 photos, and you'll get a price from what's actually selling now - plus the box and weight to ship it.",
      ...(demo ? [`See it work in 30 seconds: ${demo}`] : [])],
      `${origin}/`, "Guestimate something", await offLink(env, origin, g.user_id));
    await sendAlert(env, { to: g.email, subject: have > 0 ? `Your ${plural(have, "free credit")} ${have === 1 ? "is" : "are"} waiting` : "Price your first thing in 2 minutes", ...e });
    sent.push({ kind: "first", user: g.user_id });
  }
  const w2 = (await db.prepare(
    `SELECT g.user_id, u.email, (SELECT MAX(a.created_at) ${OWNED}) last_est FROM gs_users g JOIN users u ON u.id=g.user_id
      WHERE COALESCE(g.marketing_off,0)=0 AND (g.winback2_at IS NULL OR g.winback2_at<?) AND EXISTS (SELECT 1 ${OWNED})
        AND (SELECT MAX(a.created_at) ${OWNED}) < ? AND NOT EXISTS (SELECT 1 FROM ebay_listings l WHERE l.user_id=g.user_id AND l.updated_at>=?) LIMIT 25`)
    .bind(iso(ms - W2_AGAIN_D * DAY), iso(ms - W2_QUIET_D * DAY), iso(ms - W2_QUIET_D * DAY)).all()).results || [];
  for (const g of w2) {
    const items = (await db.prepare(
      `SELECT COALESCE(i.ai_title, i.name) t FROM items i JOIN sales s ON s.id=i.sale_id WHERE s.user_id=? AND i.status<>'sold'
         AND COALESCE(i.listing_status,'') NOT IN ('live','sold') AND EXISTS (SELECT 1 FROM appraisals a WHERE a.item_id=i.id AND a.status='done')
       ORDER BY i.created_at DESC LIMIT 50`).bind(g.user_id).all()).results || [];
    if (!items.length) continue;   // nothing waiting: no reason to write
    const m = await db.prepare("UPDATE gs_users SET winback2_at=? WHERE user_id=? AND (winback2_at IS NULL OR winback2_at<?)").bind(iso(ms), g.user_id, iso(ms - W2_AGAIN_D * DAY)).run();
    if (!(m.meta && m.meta.changes)) continue;
    const names = items.slice(0, 3).map(x => x.t).join(", ") + (items.length > 3 ? ` and ${items.length - 3} more` : "");
    const e = mail(`${items.length} priced item${items.length === 1 ? " is" : "s are"} waiting`, [`You priced ${names}, but ${items.length === 1 ? "it isn't" : "they aren't"} listed yet.`,
      "Prices move - open one to see what it's selling for today, then list it on eBay in a couple of taps."],
      `${origin}/`, "See my items", await offLink(env, origin, g.user_id));
    await sendAlert(env, { to: g.email, subject: `Your ${items.length === 1 ? "item is" : `${items.length} items are`} still waiting to sell`, ...e });
    sent.push({ kind: "quiet", user: g.user_id, items: items.length });
  }
  return sent;
}

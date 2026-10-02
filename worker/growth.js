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

/** Cron: at most 25 of each email per run; each person gets each email once (W2: once per 90 days). */
export async function winbackSweep(env, db, origin, ms = Date.now()) {
  const sent = [];
  const w1 = (await db.prepare(
    `SELECT g.user_id, u.email FROM gs_users g JOIN users u ON u.id=g.user_id
      WHERE g.winback1_at IS NULL AND COALESCE(g.marketing_off,0)=0 AND g.created_at<=? AND g.created_at>=? AND NOT EXISTS (SELECT 1 ${OWNED}) LIMIT 25`)
    .bind(iso(ms - W1_AFTER_D * DAY), iso(ms - W1_UNTIL_D * DAY)).all()).results || [];
  for (const g of w1) {
    const m = await db.prepare("UPDATE gs_users SET winback1_at=? WHERE user_id=? AND winback1_at IS NULL").bind(iso(ms), g.user_id).run();
    if (!(m.meta && m.meta.changes)) continue;
    const e = mail("What's in your closet worth?", ["You made a Guestimator account but haven't priced anything yet.",
      "Pick one thing you've been meaning to sell, snap 2-4 photos, and you'll get a price from what's actually selling now - plus the box and weight to ship it."],
      `${origin}/`, "Guestimate something", await offLink(env, origin, g.user_id));
    await sendAlert(env, { to: g.email, subject: "Price your first thing in 2 minutes", ...e });
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

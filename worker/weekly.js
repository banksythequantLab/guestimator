// Weekly selling summary: one Monday email per seller - what sold in the last 7 days, what is
// listed and how each listing's price compares with recent eBay sales, offer settings, and the
// unsold stock still at home. Built only from what Guestimator already knows (no lookups, no
// model calls), so sending it costs nothing. Sellers with nothing listed and nothing sold get none.

import { profitRows, inventorySummary } from "./profit.js";
import { verdict, MIN_SALES } from "./pricecheck.js";
import { sendAlert } from "./notify.js";

const DAY = 86400e3;
const enc = new TextEncoder();
const money = c => "$" + (Number(c || 0) / 100).toFixed(2);
const esc = s => String(s ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

// Mondays from 13:00 UTC (9am New York): the cron runs every 15 minutes, so the first run in the
// window sends and the weekly_sent_at gate keeps later runs from sending again.
export const inSendWindow = nowMs => { const d = new Date(nowMs); return d.getUTCDay() === 1 && d.getUTCHours() >= 13; };

async function sign(env, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode("weekly-off:" + String(env.EBAY_TOKEN_KEY || env.SESSION_KEY || "guestimator")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)))].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
export const offLink = async (env, origin, userId) => `${origin}/api/weekly/off?u=${encodeURIComponent(userId)}&t=${await sign(env, userId)}`;
export const offTokenOk = async (env, userId, t) => !!userId && typeof t === "string" && t === await sign(env, userId);

export async function weeklySummary(db, userId, nowMs = Date.now()) {
  const from = new Date(nowMs - 7 * DAY).toISOString().slice(0, 10);
  const sold = await profitRows(db, userId, { from });
  const rows = (await db.prepare(
    `SELECT l.id, l.price_cents, l.created_at, l.listing_url, l.best_offer_accept_cents, l.best_offer_decline_cents,
            l.sold_count, l.sold_median_cents, l.sold_checked_at, COALESCE(i.ai_title, i.name) AS title
       FROM ebay_listings l JOIN items i ON i.id=l.item_id
      WHERE l.user_id=? AND l.status='published' AND i.listing_status='live'
        AND l.created_at = (SELECT MAX(created_at) FROM ebay_listings x WHERE x.item_id=l.item_id)
      ORDER BY l.created_at`).bind(userId).all()).results;
  const listings = rows.map(r => {
    const v = (r.sold_count || 0) >= MIN_SALES && r.sold_median_cents
      ? verdict(r.price_cents, { count: r.sold_count, median: r.sold_median_cents / 100 })
      : { verdict: !r.sold_checked_at ? "unknown" : r.sold_count ? "thin" : "none" };
    return { title: r.title, url: r.listing_url, price_cents: r.price_cents, days: Math.max(0, Math.floor((nowMs - Date.parse(r.created_at)) / DAY)),
      offers: r.best_offer_accept_cents != null ? { accept_cents: r.best_offer_accept_cents, decline_cents: r.best_offer_decline_cents } : null,
      sold_count: r.sold_count || 0, sold_median_cents: r.sold_median_cents, ...v };
  });
  return { sold: sold.rows, sold_totals: sold.totals, listings, inventory: await inventorySummary(db, userId) };
}

const VERDICT = {
  high: l => `about ${l.pct}% above the ${money(l.median_cents)} median of ${l.sold_count} recent sales. Try ${money(l.suggested_cents)}.`,
  low: l => `${l.pct}% below recent sales (median ${money(l.median_cents)}).`,
  ok: l => `in line with recent sales (median ${money(l.median_cents)}).`,
  thin: () => "too few recent sales to compare.",
  none: () => "no recent eBay sales of this found.",
  unknown: () => "not price-checked yet.",
};

export function weeklyEmail(sum, origin, off) {
  const n = sum.sold.length;
  const subject = n ? `This week: ${n} sold, ${money(sum.sold_totals.sale_cents)}` : `This week: ${sum.listings.length} listed on eBay`;
  const soldLines = sum.sold.map(r => `${r.title} - ${money(r.sale_cents)} (${r.channel})`);
  const listLines = sum.listings.map(l => `${l.title}: ${money(l.price_cents)}, ${l.days} day${l.days === 1 ? "" : "s"} listed, ${(VERDICT[l.verdict] || VERDICT.unknown)(l)}` +
    (l.offers ? ` Offers on (${money(l.offers.accept_cents)}+ accepted${l.offers.decline_cents ? `, under ${money(l.offers.decline_cents)} declined` : ""}).` : " Offers off."));
  const inv = sum.inventory;
  const invLine = inv.items ? `${inv.items} unsold item${inv.items === 1 ? "" : "s"} in your inventory${inv.estimate_cents ? `, estimated at ${money(inv.estimate_cents)}` : ""}.` : "";
  const link = `${origin}/#ebay-orders`;
  const text = [subject, "",
    n ? "SOLD THIS WEEK" : "Nothing sold this week.", ...soldLines, "",
    sum.listings.length ? "LISTED ON EBAY" : "", ...listLines, "", invLine, "",
    `Review prices and offers: ${link}`, "", `Stop these weekly emails: ${off}`].filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n");
  const li = arr => arr.length ? `<ul style="font-size:14px;padding-left:18px">${arr.map(x => `<li style="margin:4px 0">${esc(x)}</li>`).join("")}</ul>` : "";
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#ffffff;margin:0;padding:24px;color:#241b10">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:14px;padding:20px">
<div style="font-weight:800;font-size:18px;margin-bottom:10px">${esc(subject)}</div>
<div style="font-weight:700;margin-top:8px">${n ? "Sold this week" : "Nothing sold this week"}</div>${li(soldLines)}
${sum.listings.length ? `<div style="font-weight:700;margin-top:8px">Listed on eBay</div>${li(listLines)}` : ""}
${invLine ? `<p style="font-size:14px">${esc(invLine)}</p>` : ""}
<a href="${esc(link)}" style="display:inline-block;background:#d97757;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:10px">Review prices &amp; offers</a>
<div style="margin-top:14px;font-size:12px;color:#6a5b44"><a href="${esc(off)}" style="color:#6a5b44">Stop these weekly emails</a></div></div></body></html>`;
  return { subject, text, html };
}

/** Send the week's summaries. Safe to call every cron tick: only Mondays from 13:00 UTC, once a week per seller. */
export async function emailWeekly(env, db, origin, { nowMs = Date.now(), max = 25, force = false } = {}) {
  if (!force && !inSendWindow(nowMs)) return { sent: 0, window: false };
  const since = new Date(nowMs - 6 * DAY).toISOString();
  const weekAgo = new Date(nowMs - 7 * DAY).toISOString();
  const { results } = await db.prepare(
    `SELECT u.id, u.email FROM users u
      WHERE EXISTS (SELECT 1 FROM ebay_accounts a WHERE a.user_id=u.id)
        AND (EXISTS (SELECT 1 FROM ebay_listings l WHERE l.user_id=u.id AND l.status='published')
             OR EXISTS (SELECT 1 FROM ebay_orders o WHERE o.user_id=u.id AND o.ordered_at >= ?))
        AND NOT EXISTS (SELECT 1 FROM seller_settings s WHERE s.user_id=u.id AND (COALESCE(s.weekly_off,0)=1 OR s.weekly_sent_at >= ?))
      LIMIT ?`).bind(weekAgo, since, max).all();
  let sent = 0;
  for (const u of results) {
    if (!u.email) continue;
    const sum = await weeklySummary(db, u.id, nowMs);
    if (!sum.sold.length && !sum.listings.length) continue;
    const m = weeklyEmail(sum, origin, await offLink(env, origin, u.id));
    const r = await sendAlert(env, { to: u.email, ...m });
    if (r.sent) {
      sent++;
      const ts = new Date(nowMs).toISOString();
      await db.prepare("INSERT INTO seller_settings (user_id, weekly_sent_at, updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET weekly_sent_at=excluded.weekly_sent_at, updated_at=excluded.updated_at")
        .bind(u.id, ts, ts).run();
    }
  }
  return { sent, window: true };
}

export async function turnOff(db, userId, nowMs = Date.now()) {
  const ts = new Date(nowMs).toISOString();
  await db.prepare("INSERT INTO seller_settings (user_id, weekly_off, updated_at) VALUES (?,1,?) ON CONFLICT(user_id) DO UPDATE SET weekly_off=1, updated_at=excluded.updated_at").bind(userId, ts).run();
}
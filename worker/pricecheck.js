// Price check: each live eBay listing against what the same thing actually SOLD for on eBay in
// the last 90 days (SoldComps). A listing priced well above recent sales is the most common reason
// it sits, and the fix is one tap. Sold prices exclude shipping, as do our listing prices.
//
// Evidence comes from the item's latest estimate when that estimate already carries sold prices
// judged by the model (sold_market, under a week old). Otherwise one fresh lookup per listing (up
// to three SoldComps requests on the broadening ladder), filtered by the same kit/spec rules.

import { ebaySold, soldFailure, summarise, compsQuery } from "./appraiser.js";

const DAY = 86400e3;
export const FRESH_DAYS = 7;
export const HIGH = 1.15, LOW = 0.85, MIN_SALES = 3;

// Round DOWN to a price people expect: whole dollars from $20, 50c steps below.
export const niceDown = cents => cents >= 2000 ? Math.floor(cents / 100) * 100 : Math.floor(cents / 50) * 50;

/** Pure: compare one listing price (cents) with a sold summary ({count, median, ...} in dollars). */
export function verdict(priceCents, sold) {
  if (!sold || !sold.count) return { verdict: "none" };
  const med = Math.round(sold.median * 100);
  if (sold.count < MIN_SALES) return { verdict: "thin", median_cents: med };
  const ratio = priceCents / med;
  if (ratio > HIGH) {
    const s = niceDown(med);
    return { verdict: "high", median_cents: med, pct: Math.round((ratio - 1) * 100), suggested_cents: s > 0 && s < priceCents ? s : null };
  }
  if (ratio < LOW) return { verdict: "low", median_cents: med, pct: Math.round((1 - ratio) * 100) };
  return { verdict: "ok", median_cents: med };
}

export async function priceCheck(env, db, userId, { nowMs = Date.now(), maxListings = 15 } = {}) {
  const rows = (await db.prepare(
    `SELECT l.id, l.item_id, l.price_cents, l.listing_url, COALESCE(i.ai_title, i.name) AS title,
            (SELECT result_json FROM appraisals a WHERE a.item_id=l.item_id AND a.status='done' ORDER BY a.created_at DESC LIMIT 1) AS result_json
       FROM ebay_listings l JOIN items i ON i.id=l.item_id
      WHERE l.user_id=? AND l.status='published' AND i.listing_status='live' AND l.offer_id IS NOT NULL
        AND l.created_at = (SELECT MAX(created_at) FROM ebay_listings x WHERE x.item_id=l.item_id)
      ORDER BY l.updated_at LIMIT ?`).bind(userId, maxListings).all()).results;
  const out = [];
  for (const r of rows) {
    let res = null; try { res = JSON.parse(r.result_json || "null"); } catch {}
    let sold = null, recent = [], source = "fresh", why = null;
    const sm = res?.sold_market;
    if (sm && sm.count && nowMs - Date.parse(sm.as_of || 0) < FRESH_DAYS * DAY) {
      sold = sm; recent = sm.recent || []; source = "estimate";
    } else {
      const q = res?.identification ? compsQuery(res.identification) : r.title;
      const list = await ebaySold(env, q);
      if (list && list.length) { sold = summarise(list, "eBay sold, last 90 days"); recent = list; }
      else why = soldFailure();
    }
    out.push({ id: r.id, item_id: r.item_id, title: r.title, listing_url: r.listing_url, price_cents: r.price_cents,
      sold: sold ? { count: sold.count, low: sold.low, high: sold.high, median: sold.median } : null,
      recent: recent.slice(0, 3).map(s => ({ title: s.title, url: s.url, price: s.price, sold_at: s.sold_at })),
      source, why, ...verdict(r.price_cents, sold) });
  }
  return { listings: out, checked_at: new Date(nowMs).toISOString() };
}
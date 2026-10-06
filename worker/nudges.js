// Price-drop nudges: an eBay listing that has sat unsold for two weeks gets a suggested lower
// price, shown in the app and emailed (at most every two weeks per listing), and one tap lowers
// it on eBay. The suggestion never goes below the low end of the item's estimate.

import * as ebay from "./ebay.js";
import { sendAlert } from "./notify.js";
import { verdict, MIN_SALES, soldFor, cacheSold, genuinelyNone } from "./pricecheck.js";

export const SLOW_DAYS = 14;
const DAY = 86400e3;

// 10% off, rounded down to a price people expect ($1 steps from $20, 50c steps below), and never
// under the estimate's low end. null = not worth a nudge (the drop would be under a dollar, or the
// price is already at the floor).
export function suggestLower(priceCents, lowDollars, pct = 0.10) {
  const p = Number(priceCents);
  if (!(p > 0)) return null;
  let t = p * (1 - pct);
  t = t >= 2000 ? Math.floor(t / 100) * 100 : Math.floor(t / 50) * 50;
  const floor = Number(lowDollars) > 0 ? Math.round(Number(lowDollars) * 100) : 0;
  if (t < floor) t = floor;
  if (p - t < 100 || t <= 0) return null;
  return t;
}

// What to suggest for a slow listing. Recent eBay sales decide when there are enough of them: priced
// well above the median sale -> suggest the median; already in line or below -> no cut (a lower
// price is not what's holding it back, so no nudge). Too few sales to judge -> the old rule,
// 10% off, never under the estimate's low end.
export const SOLD_FRESH_DAYS = 7;
export function nudgeFor(priceCents, lowDollars, soldCount, soldMedianCents) {
  if (soldCount >= MIN_SALES && soldMedianCents > 0) {
    const v = verdict(priceCents, { count: soldCount, median: soldMedianCents / 100 });
    return v.verdict === "high" && v.suggested_cents ? { suggested_cents: v.suggested_cents, basis: "sold", median_cents: soldMedianCents, sold_count: soldCount } : null;
  }
  const s = suggestLower(priceCents, lowDollars);
  return s ? { suggested_cents: s, basis: "pct" } : null;
}

// Listings that are live, ours, and have not moved in SLOW_DAYS. `forEmail` also skips ones
// emailed in the last SLOW_DAYS; the app view skips ones the seller chose to keep.
export async function slowListings(db, userId, { nowMs = Date.now(), forEmail = false, env = null, maxLookups = 10 } = {}) {
  const cut = new Date(nowMs - SLOW_DAYS * DAY).toISOString();
  const q = `SELECT l.id, l.item_id, l.user_id, l.offer_id, l.sku, l.listing_url, l.price_cents, l.updated_at,
                    l.sold_count, l.sold_median_cents, l.sold_checked_at,
                    COALESCE(i.ai_title, i.name) AS title,
                    (SELECT result_json FROM appraisals a WHERE a.item_id=l.item_id AND a.status='done' ORDER BY a.created_at DESC LIMIT 1) AS result_json
               FROM ebay_listings l JOIN items i ON i.id=l.item_id
              WHERE l.status='published' AND i.listing_status='live' AND l.updated_at < ? AND l.offer_id IS NOT NULL
                AND (? = '' OR l.user_id = ?)
                -- only where we can see sales: never nudge something that may have sold already
                AND EXISTS (SELECT 1 FROM ebay_accounts a WHERE a.user_id=l.user_id AND COALESCE(a.fulfillment_ok,1)<>0 AND a.orders_synced_at IS NOT NULL)
                AND ${forEmail ? "(l.nudge_emailed_at IS NULL OR l.nudge_emailed_at < ?)" : "(l.nudge_dismissed_at IS NULL OR l.nudge_dismissed_at < ?)"}
                AND l.created_at = (SELECT MAX(created_at) FROM ebay_listings x WHERE x.item_id=l.item_id)
              ORDER BY l.updated_at LIMIT 100`;
  const rows = (await db.prepare(q).bind(cut, userId || "", userId || "", cut).all()).results;
  // The email pass may look sales up (a few per run); the in-app view only reads what was found
  // before, so opening the screen never spends lookups.
  let looked = 0;
  const out = [];
  for (const r of rows) {
    if (env && forEmail && looked < maxLookups && (!r.sold_checked_at || nowMs - Date.parse(r.sold_checked_at) > SOLD_FRESH_DAYS * DAY)) {
      looked++;
      const f = await soldFor(env, r, nowMs);
      await cacheSold(db, r.id, f.sold, nowMs, f.why);
      if (f.sold) { r.sold_count = f.sold.count; r.sold_median_cents = Math.round(f.sold.median * 100); }
      else if (genuinelyNone(f.why)) { r.sold_count = 0; r.sold_median_cents = null; }
    }
    let low = null; try { low = JSON.parse(r.result_json || "null")?.price_range?.low ?? null; } catch {}
    const n = nudgeFor(r.price_cents, low, r.sold_count || 0, r.sold_median_cents);
    if (!n) continue;
    out.push({ id: r.id, item_id: r.item_id, user_id: r.user_id, offer_id: r.offer_id, sku: r.sku, title: r.title, listing_url: r.listing_url,
               price_cents: r.price_cents, low_cents: low != null ? Math.round(low * 100) : null, suggested_cents: n.suggested_cents,
               basis: n.basis, sold_median_cents: n.median_cents ?? null, sold_count: n.sold_count ?? null,
               days: Math.floor((nowMs - Date.parse(r.updated_at)) / DAY) });
  }
  return out;
}

/** Change the price on eBay (Inventory API bulk price update), then here. Restarts the clock. */
export async function lowerPrice(env, db, userId, listingRowId, newCents) {
  return changePrice(env, db, userId, listingRowId, newCents, { lowerOnly: true });
}

/** Set a live listing's price, up or down. With Best Offer on, its thresholds move with the price —
 *  eBay refuses a price at or under the auto-accept amount, which is what made a seller's own price
 *  edit on eBay snap back (2026-10-05). */
export async function changePrice(env, db, userId, listingRowId, newCents, { lowerOnly = false } = {}) {
  const l = await db.prepare("SELECT l.*, i.listing_status FROM ebay_listings l JOIN items i ON i.id=l.item_id WHERE l.id=? AND l.user_id=?").bind(listingRowId, userId).first();
  if (!l) return { status: 404, error: "not found" };
  if (l.status !== "published" || l.listing_status !== "live" || !l.offer_id) return { status: 409, error: "This listing isn't live any more." };
  const cents = Math.round(Number(newCents));
  if (!(cents >= 99)) return { status: 400, error: "Set a price of at least $0.99." };
  if (lowerOnly && cents >= l.price_cents) return { status: 400, error: "The new price has to be lower than the current one." };
  if (cents === l.price_cents) return { status: 200, ok: true, price_cents: cents, best_offer: null, unchanged: true };
  const t = await ebay.userToken(env, db, userId);
  if (!t) return { status: 409, error: "Connect eBay again first." };
  // With Best Offer on, the auto-accept price has to come down with the price (eBay won't take an
  // auto-accept at or above the price), so both change in one offer update.
  let terms = null;
  if (l.best_offer_accept_cents != null) {
    terms = ebay.bestOfferTerms(cents / 100, await floorOf(db, l.item_id), l.best_offer_min_cents && l.best_offer_min_cents < cents ? l.best_offer_min_cents : null);
    const u = await ebay.updateOfferTerms(env, t.token, l.offer_id, terms, cents);
    if (u.error) return { status: 502, error: u.error };
  } else {
    const body = { requests: [{ sku: l.sku, offers: [{ offerId: l.offer_id, availableQuantity: 1, price: { value: (cents / 100).toFixed(2), currency: "USD" } }] }] };
    const r = await ebay.call(env, t.token, "POST", "/sell/inventory/v1/bulk_update_price_quantity", body);
    const res = (r.json?.responses || [])[0];
    if (!r.ok || (res && res.statusCode && res.statusCode >= 400)) {
      const errs = (res?.errors || r.json?.errors || []).map(e => e.longMessage || e.message).filter(Boolean).join(" ");
      return { status: 502, error: errs || ebay.ebayErrorText(r.json, r.status) };
    }
  }
  const ts = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE ebay_listings SET price_cents=?, best_offer_accept_cents=?, best_offer_decline_cents=?, updated_at=?, nudge_dismissed_at=NULL WHERE id=?")
      .bind(cents, terms ? terms.accept_cents : null, terms ? terms.decline_cents : null, ts, l.id),
    db.prepare("UPDATE items SET price_cents=? WHERE id=?").bind(cents, l.item_id),
  ]);
  return { status: 200, ok: true, price_cents: cents, best_offer: terms };
}

// The lowest the item's latest estimate said to take (floor, else the low end), in dollars.
async function floorOf(db, itemId) {
  const ap = await db.prepare("SELECT result_json FROM appraisals WHERE item_id=? AND status='done' ORDER BY created_at DESC LIMIT 1").bind(itemId).first();
  try { const pr = JSON.parse(ap?.result_json || "null")?.price_range; return pr?.floor || pr?.low || null; } catch { return null; }
}

/** Turn Best Offer on or off for a live listing. Thresholds come from its price and the floor. */
export async function setListingBestOffer(env, db, userId, listingRowId, enabled, minCents) {
  const l = await db.prepare("SELECT l.*, i.listing_status FROM ebay_listings l JOIN items i ON i.id=l.item_id WHERE l.id=? AND l.user_id=?").bind(listingRowId, userId).first();
  if (!l) return { status: 404, error: "not found" };
  if (l.status !== "published" || l.listing_status !== "live" || !l.offer_id) return { status: 409, error: "This listing isn't live any more." };
  // minCents: undefined keeps what was set before; null clears it; a number sets it.
  const min = minCents === undefined ? l.best_offer_min_cents : (Number(minCents) > 0 ? Math.round(Number(minCents)) : null);
  if (enabled && min && min >= l.price_cents) return { status: 400, error: "The lowest offer has to be under the price." };
  const terms = enabled ? ebay.bestOfferTerms(l.price_cents / 100, await floorOf(db, l.item_id), min) : null;
  if (enabled && !terms) return { status: 400, error: "Offers are only worth turning on for items priced $10 or more." };
  const t = await ebay.userToken(env, db, userId);
  if (!t) return { status: 409, error: "Connect eBay again first." };
  const u = await ebay.updateOfferTerms(env, t.token, l.offer_id, terms);
  if (u.error) return { status: 502, error: u.error };
  await db.prepare("UPDATE ebay_listings SET best_offer_accept_cents=?, best_offer_decline_cents=?, best_offer_min_cents=? WHERE id=?")
    .bind(terms ? terms.accept_cents : null, terms ? terms.decline_cents : null, min ?? null, l.id).run();
  return { status: 200, ok: true, best_offer: terms };
}

const money = c => "$" + (Number(c || 0) / 100).toFixed(2);

/** One digest email per seller for listings that have gone slow since the last one. */
export async function emailNudges(env, db, origin, { nowMs = Date.now(), maxSellers = 25 } = {}) {
  const due = await slowListings(db, null, { nowMs, forEmail: true, env });
  const bySeller = new Map();
  for (const d of due) (bySeller.get(d.user_id) || bySeller.set(d.user_id, []).get(d.user_id)).push(d);
  let sent = 0;
  for (const [userId, list] of [...bySeller].slice(0, maxSellers)) {
    const u = await db.prepare("SELECT email FROM users WHERE id=?").bind(userId).first();
    if (!u?.email) continue;
    const lines = list.slice(0, 10).map(d => `${d.title}: ${money(d.price_cents)} for ${d.days} days. Try ${money(d.suggested_cents)}` +
      (d.basis === "sold" ? ` (${d.sold_count} recent eBay sales, median ${money(d.sold_median_cents)}).` : "."));
    const link = `${origin}/#ebay-orders`;
    const title = list.length === 1 ? `Still listed: ${list[0].title}` : `${list.length} eBay listings haven't sold yet`;
    const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f4ecdc;margin:0;padding:24px;color:#241b10">
<div style="max-width:520px;margin:0 auto;background:#fbf6ea;border:1px solid #e0d2b4;border-radius:14px;padding:20px">
<div style="font-weight:800;font-size:18px;margin-bottom:10px">${title.replace(/[<>&]/g, "")}</div>
<p style="font-size:14px">A small price drop is often all a slow listing needs. Where there are enough recent eBay sales, the suggestion is what the same thing actually sold for; otherwise it's 10% off, never below the low end of our estimate.</p>
<ul style="font-size:14px;padding-left:18px">${lines.map(x => `<li style="margin:4px 0">${x.replace(/[<>&]/g, "")}</li>`).join("")}</ul>
<a href="${link}" style="display:inline-block;background:#241b10;color:#f4ecdc;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:10px">Review prices</a>
<div style="margin-top:14px;font-size:12px;color:#6a5b44">One tap lowers it on eBay, or keep the price and we won't ask again for two weeks.</div></div></body></html>`;
    const r = await sendAlert(env, { to: u.email, subject: title, html,
      text: [title, "", ...lines, "", `Review prices: ${link}`, "", "One tap lowers it on eBay, or keep the price and we won't ask again for two weeks."].join("\n") });
    if (r.sent) {
      sent++;
      const ts = new Date(nowMs).toISOString();
      await db.batch(list.map(d => db.prepare("UPDATE ebay_listings SET nudge_emailed_at=? WHERE id=?").bind(ts, d.id)));
    }
  }
  return { sellers: bySeller.size, sent };
}

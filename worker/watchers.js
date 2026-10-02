// Offers to interested buyers: eBay lets a seller send a discount to everyone who is watching a
// listing (or left it in a cart). The Negotiation API says which listings have such buyers right
// now; one call sends the offer and eBay messages each of them. It never goes below the lowest
// price the seller said they'd take (their offer minimum, else the estimate's floor).

import * as ebay from "./ebay.js";

const DAY = 86400e3;
export const MIN_PCT = 5, MAX_PCT = 50, COOLDOWN_DAYS = 3;

/** Price after a whole-percent discount, in cents (eBay rounds the same way: to the cent). */
export const discounted = (cents, pct) => Math.round(cents * (100 - pct) / 100);

export async function interested(env, db, userId, { nowMs = Date.now() } = {}) {
  const t = await ebay.userToken(env, db, userId);
  if (!t) return { status: 409, error: "Connect your eBay account first", needs_connect: true };
  const r = await ebay.call(env, t.token, "GET", "/sell/negotiation/v1/find_eligible_items?limit=200");
  if (!r.ok && r.status !== 204) return { status: 502, error: ebay.ebayErrorText(r.json, r.status) };
  const ids = new Set(((r.json && r.json.eligibleItems) || []).map(x => String(x.listingId)));
  if (!ids.size) return { status: 200, listings: [] };
  const rows = (await db.prepare(
    `SELECT l.id, l.listing_id, l.listing_url, l.price_cents, l.best_offer_min_cents, l.best_offer_decline_cents, l.watch_offer_at, l.watch_offer_pct,
            COALESCE(i.ai_title, i.name) AS title,
            (SELECT result_json FROM appraisals a WHERE a.item_id=l.item_id AND a.status='done' ORDER BY a.created_at DESC LIMIT 1) AS rj
       FROM ebay_listings l JOIN items i ON i.id=l.item_id
      WHERE l.user_id=? AND l.status='published' AND i.listing_status='live' AND l.listing_id IS NOT NULL`).bind(userId).all()).results;
  return { status: 200, listings: rows.filter(x => ids.has(String(x.listing_id))).map(x => {
    let floor = null; try { const pr = JSON.parse(x.rj || "null")?.price_range; floor = pr?.floor || pr?.low || null; } catch {}
    // The lowest the seller would take: their own minimum, else where Best Offer auto-declines, else the estimate's floor.
    const min = x.best_offer_min_cents || x.best_offer_decline_cents || (floor ? Math.round(floor * 100) : null);
    const maxPct = min ? Math.max(0, Math.min(MAX_PCT, Math.floor((1 - min / x.price_cents) * 100))) : MAX_PCT;
    const wait = x.watch_offer_at ? Math.max(0, Math.ceil((Date.parse(x.watch_offer_at) + COOLDOWN_DAYS * DAY - nowMs) / DAY)) : 0;
    return { id: x.id, title: x.title, listing_url: x.listing_url, price_cents: x.price_cents, min_cents: min, max_pct: maxPct,
             last_offer_at: x.watch_offer_at, last_offer_pct: x.watch_offer_pct, wait_days: wait };
  }) };
}

export async function sendOffer(env, db, userId, listingRowId, pct, { nowMs = Date.now(), message = "" } = {}) {
  const p = Math.round(Number(pct));
  if (!(p >= MIN_PCT && p <= MAX_PCT)) return { status: 400, error: `Pick a discount between ${MIN_PCT}% and ${MAX_PCT}%.` };
  const list = await interested(env, db, userId, { nowMs });
  if (list.error) return list;
  const l = list.listings.find(x => x.id === listingRowId);
  if (!l) return { status: 409, error: "eBay says nobody is watching this listing right now, so there's no one to send an offer to." };
  if (l.wait_days) return { status: 409, error: `You sent an offer on this one recently. Try again in ${l.wait_days} day${l.wait_days === 1 ? "" : "s"}.` };
  if (p > l.max_pct) return { status: 400, error: `${p}% off would go below the lowest price you'd take (${(l.min_cents / 100).toFixed(2)}). Up to ${l.max_pct}% is OK.` };
  const t = await ebay.userToken(env, db, userId);
  const row = await db.prepare("SELECT listing_id FROM ebay_listings WHERE id=?").bind(listingRowId).first();
  const body = { offeredItems: [{ listingId: String(row.listing_id), quantity: 1, discountPercentage: String(p) }], allowCounterOffer: false,
                 offerDuration: { unit: "DAY", value: 2 },
                 message: String(message || "Thanks for watching - here's a little off if you'd like it.").slice(0, 2000) };
  const r = await ebay.call(env, t.token, "POST", "/sell/negotiation/v1/send_offer_to_interested_buyers", body);
  if (!r.ok) return { status: 502, error: ebay.ebayErrorText(r.json, r.status) };
  const sent = ((r.json && r.json.offers) || []).length;
  await db.prepare("UPDATE ebay_listings SET watch_offer_at=?, watch_offer_pct=? WHERE id=?").bind(new Date(nowMs).toISOString(), p, listingRowId).run();
  return { status: 200, ok: true, sent, pct: p, price_cents: discounted(l.price_cents, p) };
}
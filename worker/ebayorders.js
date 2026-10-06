// eBay sales of things listed through Guestimator: read them from the Sell Fulfillment API, tell
// the seller, keep the item from being sold twice (a garage-sale copy is marked sold), and mark
// the order shipped on eBay with its tracking number.
//
// Pure functions first (tested without eBay in tests/ebayorders_test.mjs); the calls below are
// thin, and a failure is eBay's own words passed through.

import * as ebay from "./ebay.js";
import { endEtsyListing } from "./etsy.js";

const cents = v => (v == null || v === "" || !Number.isFinite(Number(v))) ? null : Math.round(Number(v) * 100);

// One eBay order -> the fields we keep, with the address in the same shape Stripe Checkout gives
// garage orders ({name, phone, address:{line1,...}}) so one packing slip serves both.
export function parseOrder(o) {
  const step = (o.fulfillmentStartInstructions || [])[0]?.shippingStep || {};
  const to = step.shipTo || {};
  const a = to.contactAddress || {};
  const cancelled = /CANCEL/i.test(o.cancelStatus?.cancelState || "") && !/NONE/i.test(o.cancelStatus?.cancelState || "");
  return {
    orderId: String(o.orderId || ""),
    orderedAt: o.creationDate || null,
    status: cancelled ? "CANCELLED" : String(o.orderFulfillmentStatus || "NOT_STARTED"),
    paid: !o.orderPaymentStatus || /PAID/i.test(o.orderPaymentStatus),
    buyer: o.buyer?.username || null,
    totalCents: cents(o.pricingSummary?.total?.value),
    feeCents: cents(o.totalMarketplaceFee?.value),
    shipPaidCents: cents(o.pricingSummary?.deliveryCost?.value),
    shipService: step.shippingServiceCode || null,
    shipTo: to.fullName || a.addressLine1 ? {
      name: to.fullName || "", phone: to.primaryPhone?.phoneNumber || "",
      address: { line1: a.addressLine1 || "", line2: a.addressLine2 || "", city: a.city || "",
                 state: a.stateOrProvince || "", postal_code: a.postalCode || "", country: a.countryCode || "US" },
    } : null,
    lines: (o.lineItems || []).map(l => ({
      lineItemId: String(l.lineItemId || ""), sku: l.sku || "", legacyItemId: l.legacyItemId || null,
      title: l.title || "", quantity: Number(l.quantity) || 1,
      shipBy: l.lineItemFulfillmentInstructions?.shipByDate || null,
    })),
  };
}

// The getOrders filter eBay wants: ISO with milliseconds, open-ended range.
export function sinceFilter(sinceIso) {
  return `lastmodifieddate:[${new Date(sinceIso).toISOString()}..]`;
}

// Where to start reading: a little before the last read (clocks and eBay's indexing lag), never
// further back than 30 days, and never before the account was connected.
export function syncSince(acct, nowMs = Date.now()) {
  const floor = nowMs - 30 * 86400e3;
  const last = acct.orders_synced_at ? Date.parse(acct.orders_synced_at) - 3600e3 : Date.parse(acct.created_at || 0) - 86400e3;
  return new Date(Math.max(floor, Number.isFinite(last) ? last : floor)).toISOString();
}

// eBay's carrier code, from the tracking number's shape; null means "can't tell", and then the
// seller picks the carrier.
export function carrierFor(tracking) {
  const n = String(tracking || "").replace(/\s+/g, "").toUpperCase();
  if (!n) return null;
  if (/^1Z[0-9A-Z]{16}$/.test(n)) return "UPS";
  if (/^(94|93|92|95|82)\d{18,22}$/.test(n) || /^[A-Z]{2}\d{9}US$/.test(n)) return "USPS";
  if (/^\d{12}$|^\d{15}$/.test(n)) return "FedEx";
  return null;
}

export const insufficientScope = r => r.status === 403 || (r.json?.errors || []).some(e => /insufficient|scope|access denied/i.test(`${e.message} ${e.longMessage}`));

// ---------- eBay calls ----------

async function fetchOrders(env, token, sinceIso) {
  const out = [];
  let path = `/sell/fulfillment/v1/order?filter=${encodeURIComponent(sinceFilter(sinceIso))}&limit=50`;
  for (let page = 0; page < 4 && path; page++) {
    const r = await ebay.call(env, token, "GET", path);
    if (!r.ok) return { error: r };
    out.push(...(r.json?.orders || []));
    const next = r.json?.next;
    path = next ? next.replace(/^https:\/\/api(\.sandbox)?\.ebay\.com/, "") : null;
  }
  return { orders: out };
}

/**
 * Read this seller's recent eBay orders and record the ones for Guestimator listings.
 * Returns { ok, needs_reconnect?, new: [ebay_orders.id], checked }.
 */
export async function syncOrders(env, db, userId, { nowMs = Date.now() } = {}) {
  const t = await ebay.userToken(env, db, userId);
  if (!t) return { ok: false, connected: false, new: [], checked: 0 };
  const since = syncSince(t.acct, nowMs);
  const res = await fetchOrders(env, t.token, since);
  const ts = new Date(nowMs).toISOString();
  if (res.error) {
    if (insufficientScope(res.error)) {
      await db.prepare("UPDATE ebay_accounts SET fulfillment_ok=0 WHERE user_id=?").bind(userId).run();
      return { ok: false, needs_reconnect: true, new: [], checked: 0 };
    }
    return { ok: false, error: ebay.ebayErrorText(res.error.json, res.error.status), new: [], checked: 0 };
  }
  // Our listings, by SKU. An order line for anything else on their eBay account is not ours.
  const mine = (await db.prepare("SELECT DISTINCT sku, item_id, listing_id FROM ebay_listings WHERE user_id=? AND status='published'").bind(userId).all()).results;
  const bySku = new Map(mine.map(x => [x.sku, x]));
  const byListing = new Map(mine.filter(x => x.listing_id).map(x => [String(x.listing_id), x]));
  const fresh = [];
  for (const raw of res.orders) {
    const o = parseOrder(raw);
    if (!o.orderId || !o.paid) continue;
    for (const l of o.lines) {
      const hit = bySku.get(l.sku) || (l.legacyItemId && byListing.get(String(l.legacyItemId)));
      if (!hit) continue;
      const id = `${o.orderId}:${l.lineItemId}`;
      const had = await db.prepare("SELECT status FROM ebay_orders WHERE id=?").bind(id).first();
      const shipTo = o.status === "FULFILLED" || o.status === "CANCELLED" ? null : (o.shipTo ? JSON.stringify(o.shipTo) : null);
      if (!had) {
        await db.prepare(`INSERT INTO ebay_orders (id,order_id,line_item_id,user_id,item_id,listing_id,title,quantity,buyer,total_cents,ship_to,ship_service,ship_by,status,ordered_at,created_at,updated_at,fee_cents,ship_paid_cents)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(id, o.orderId, l.lineItemId, userId, hit.item_id, l.legacyItemId || hit.listing_id || null, l.title, l.quantity, o.buyer,
                o.totalCents, shipTo, o.shipService, l.shipBy, o.status, o.orderedAt || ts, ts, ts, o.feeCents, o.shipPaidCents).run();
        if (o.status !== "CANCELLED") {
          // Sold on eBay: it is not for sale anywhere else. A garage-sale copy still marked
          // available would otherwise sell a second time to a buyer at the sale or online.
          await db.batch([
            db.prepare("UPDATE items SET listing_status='sold' WHERE id=?").bind(hit.item_id),
            db.prepare("UPDATE garage_sale_items SET status='sold' WHERE item_id=? AND status IN ('available','held','pending')").bind(hit.item_id),
          ]);
          // And off Etsy, if it was cross-listed there.
          await endEtsyListing(env, db, hit.item_id, "sold on eBay");
          // Alert only for orders still to ship. The first read after connecting also finds
          // sales the seller already shipped; marking those sold is right, emailing is noise.
          if (o.status === "NOT_STARTED" || o.status === "IN_PROGRESS") fresh.push(id);
        }
      } else {
        // eBay settles its fee after the sale, so keep the latest figures as well as the status.
        await db.prepare("UPDATE ebay_orders SET status=?, ship_to=CASE WHEN ? IN ('FULFILLED','CANCELLED') THEN NULL ELSE ship_to END, " +
                         "fee_cents=COALESCE(?, fee_cents), ship_paid_cents=COALESCE(?, ship_paid_cents), updated_at=? WHERE id=?")
          .bind(o.status, o.status, o.feeCents, o.shipPaidCents, ts, id).run();
      }
    }
  }
  await db.prepare("UPDATE ebay_accounts SET orders_synced_at=?, fulfillment_ok=1 WHERE user_id=?").bind(ts, userId).run();
  return { ok: true, new: fresh, checked: res.orders.length };
}

/** Mark an order line shipped on eBay (with tracking if given), then record it here. */
export async function markShipped(env, db, userId, rowId, tracking, carrierIn) {
  const row = await db.prepare("SELECT * FROM ebay_orders WHERE id=? AND user_id=?").bind(rowId, userId).first();
  if (!row) return { status: 404, error: "not found" };
  if (row.status === "CANCELLED") return { status: 409, error: "This order was cancelled on eBay." };
  const num = String(tracking || "").replace(/\s+/g, "").toUpperCase().slice(0, 40);
  const carrier = carrierIn || carrierFor(num);
  if (num && !carrier) return { status: 400, error: "Which carrier is that tracking number from? Pick USPS, UPS or FedEx." };
  const t = await ebay.userToken(env, db, userId);
  if (!t) return { status: 409, error: "Connect eBay again first." };
  const body = { lineItems: [{ lineItemId: row.line_item_id, quantity: row.quantity || 1 }], shippedDate: new Date().toISOString() };
  if (num) { body.trackingNumber = num; body.shippingCarrierCode = carrier; }
  const r = await ebay.call(env, t.token, "POST", `/sell/fulfillment/v1/order/${encodeURIComponent(row.order_id)}/shipping_fulfillment`, body);
  if (!r.ok) return { status: 502, error: ebay.ebayErrorText(r.json, r.status) };
  await db.prepare("UPDATE ebay_orders SET status='FULFILLED', tracking=?, ship_to=NULL, updated_at=? WHERE id=?")
    .bind(num || null, new Date().toISOString(), row.id).run();
  return { status: 200, ok: true, carrier: num ? carrier : null };
}

/**
 * The item sold somewhere else (at the garage sale, or online through Stripe): take it off eBay
 * so it cannot sell twice. Withdraws the live offer (Inventory API) and marks our listing ended.
 * Never throws: returns { ended, why } so the caller can report it.
 */
export async function endEbayListing(env, db, itemId, reason = "sold elsewhere") {
  // Every "sold somewhere else" path comes through here, so the Etsy copy is ended here too
  // (a no-op when it is not on Etsy, or when Etsy is where it sold).
  await endEtsyListing(env, db, itemId, reason);
  const l = await db.prepare("SELECT * FROM ebay_listings WHERE item_id=? AND status='published' AND offer_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").bind(itemId).first();
  if (!l) return { ended: false, why: "not on eBay" };
  // Already sold on eBay itself (our order read saw it): nothing to end.
  const soldThere = await db.prepare("SELECT 1 FROM ebay_orders WHERE item_id=? AND status<>'CANCELLED' LIMIT 1").bind(itemId).first();
  if (soldThere) return { ended: false, why: "sold on eBay" };
  try {
    const t = await ebay.userToken(env, db, l.user_id);
    if (!t) throw new Error("eBay is not connected");
    const r = await ebay.call(env, t.token, "POST", `/sell/inventory/v1/offer/${encodeURIComponent(l.offer_id)}/withdraw`);
    // 25713-ish "offer not published / already ended" means it is off eBay already: that is the goal.
    const gone = !r.ok && (r.json?.errors || []).some(e => /not (published|active)|already ended|ended|withdrawn/i.test(`${e.message} ${e.longMessage}`));
    if (!r.ok && !gone) throw new Error(ebay.ebayErrorText(r.json, r.status));
    const ts = new Date().toISOString();
    await db.batch([
      db.prepare("UPDATE ebay_listings SET status='ended', error=?, updated_at=? WHERE id=?").bind(`ended: ${reason}`.slice(0, 200), ts, l.id),
      db.prepare("UPDATE items SET listing_status='sold' WHERE id=?").bind(itemId),
    ]);
    return { ended: true, listing_url: l.listing_url };
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 300);
    await db.prepare("UPDATE ebay_listings SET error=?, updated_at=? WHERE id=?").bind(`could not end on eBay: ${msg}`, new Date().toISOString(), l.id).run();
    console.log("endEbayListing failed", itemId, msg);
    return { ended: false, why: msg, listing_url: l.listing_url };
  }
}

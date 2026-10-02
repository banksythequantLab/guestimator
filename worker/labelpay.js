// Pay-then-ship: a seller without their own Shippo account pays Guestimator for the label by card
// (Stripe Checkout on the PLATFORM account - no Stripe-Account header), and only once Stripe says
// "paid" is the label bought on the house Shippo account. If the label can't be bought, the card
// is refunded in full. Nothing is ever bought on credit.
//
// Price = Shippo's label price + LABEL_FEE_CENTS (default 0), grossed up so Stripe's card fee
// (2.9% + 30c, US cards) comes out of the seller's payment, not the house.
//
// The house Shippo plan has a monthly label cap (SHIPPO_MONTHLY_CAP, default 30 for the free
// plan). Paid labels stop at the cap so nobody pays for a label that can't be bought; raise the
// cap after upgrading the Shippo plan.
//
// Switched on with the var LABEL_PAY="on" (needs STRIPE_SECRET_KEY and SHIPPO_API_TOKEN).

import * as labels from "./labels.js";

export const STRIPE_PCT = 0.029, STRIPE_FIXED = 30;
const CHECKOUT_MINUTES = 30;   // Stripe's minimum session life

export const payOn = env => env.LABEL_PAY === "on" && !!env.STRIPE_SECRET_KEY && !!env.SHIPPO_API_TOKEN;
export const houseCap = env => Math.max(0, Math.floor(Number(env.SHIPPO_MONTHLY_CAP) || 30));
export const feeCents = env => Math.max(0, Math.floor(Number(env.LABEL_FEE_CENTS) || 0));

/** What the seller pays for a label: total covers the label, our fee and Stripe's cut of the total. */
export function priceLabel(labelCents, fee = 0) {
  const total = Math.ceil((labelCents + fee + STRIPE_FIXED) / (1 - STRIPE_PCT));
  return { label: labelCents, fee, processing: total - labelCents - fee, total };
}

/** First instant of this calendar month (UTC) as an ISO string. */
export const monthStart = (nowMs = Date.now()) => { const d = new Date(nowMs); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };

/** Labels bought on the house Shippo account this month (house + seller-paid; not sellers' own). */
export async function monthCount(db, nowMs = Date.now()) {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM shipping_labels WHERE created_at>=? AND COALESCE(payer,'house')<>'seller'").bind(monthStart(nowMs)).first();
  return Number(r?.n || 0);
}

const nowIso = () => new Date().toISOString();
const setRow = (db, id, fields) => {
  const k = Object.keys(fields);
  return db.prepare(`UPDATE label_payments SET ${k.map(x => `${x}=?`).join(",")}, updated_at=? WHERE id=?`).bind(...k.map(x => fields[x]), nowIso(), id).run();
};

/**
 * Open a Stripe Checkout for one label. `stripe(env, method, path, params)` is the platform
 * Stripe call (garage.js). Returns { status, url, price } or { status, error }.
 */
export async function startPay(env, db, userId, b, origin, stripe, nowMs = Date.now()) {
  const kind = String(b.kind || ""), orderId = String(b.order_id || "");
  const t = await labels.orderFor(db, userId, kind, orderId);
  if (t.error) return t;
  if (!t.to) return { status: 409, error: "This order has no full shipping address." };
  const had = await db.prepare("SELECT 1 FROM shipping_labels WHERE kind=? AND order_id=?").bind(kind, orderId).first();
  if (had) return { status: 409, error: "A label was already bought for this order." };
  const busy = await db.prepare("SELECT id FROM label_payments WHERE kind=? AND order_id=? AND status IN ('buying','stuck')").bind(kind, orderId).first();
  if (busy) return { status: 409, error: "A label for this order is already being bought." };
  if (await monthCount(db, nowMs) >= houseCap(env))
    return { status: 503, error: "Label buying is full for this month. Try again on the 1st, or buy the label on your carrier's site.", cap: true };
  const r = await labels.rateCents(env, b.rate_id);
  if (!r) return { status: 400, error: "Pick a rate first." };
  if (r.cents !== Number(b.amount_cents)) return { status: 409, error: "That price changed. Get rates again." };
  const price = priceLabel(r.cents, feeCents(env));
  const id = crypto.randomUUID(), at = nowIso();
  const back = `${origin}/?labelpaid=${id}`;
  const sess = await stripe(env, "POST", "/v1/checkout/sessions", {
    mode: "payment",
    success_url: back, cancel_url: `${origin}/?labelpaid=${id}&cancelled=1`,
    expires_at: Math.floor(nowMs / 1000) + CHECKOUT_MINUTES * 60 + 60,
    client_reference_id: id,
    line_items: { 0: { quantity: 1, price_data: { currency: "usd", unit_amount: price.total,
      product_data: { name: `Shipping label: ${r.service}`.slice(0, 250),
                      description: `Label $${(price.label / 100).toFixed(2)} + card processing $${((price.processing + price.fee) / 100).toFixed(2)}` } } } },
    payment_intent_data: { metadata: { label_payment: id, user: userId, kind, order: orderId } },
    metadata: { label_payment: id, user: userId, kind, order: orderId },
  });
  await db.prepare("INSERT INTO label_payments (id,user_id,kind,order_id,rate_id,file_type,label_cents,fee_cents,processing_cents,total_cents,session_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)")
    .bind(id, userId, kind, orderId, b.rate_id, b.file_type === "PDF_4x6" ? "PDF_4x6" : "PDF", price.label, price.fee, price.processing, price.total, sess.id, at, at).run();
  return { status: 200, url: sess.url, id, price };
}

async function refund(env, db, row, stripe, why) {
  try {
    await stripe(env, "POST", "/v1/refunds", { payment_intent: row.payment_intent, metadata: { label_payment: row.id } });
    await setRow(db, row.id, { status: "refunded", error: why });
    return { status: 502, error: `${why} Your card was refunded in full ($${(row.total_cents / 100).toFixed(2)}).`, refunded: true };
  } catch (e) {
    await setRow(db, row.id, { status: "stuck", error: `${why} | refund failed: ${String(e.message || e)}` });
    return { status: 502, error: `${why} The refund didn't go through automatically - we'll refund it by hand.`, stuck: true };
  }
}

/**
 * After Stripe: if the checkout is paid, buy the label on the house account (once), else say why.
 * Safe to call repeatedly (return page, order screen, cron). Returns { status, label?, ... }.
 */
export async function finishPay(env, db, userId, payId, stripe, buy, nowMs = Date.now()) {
  const row = await db.prepare("SELECT * FROM label_payments WHERE id=?").bind(String(payId || "")).first();
  if (!row || (userId && row.user_id !== userId)) return { status: 404, error: "No such label payment." };
  if (row.status === "bought") {
    const label = await db.prepare("SELECT * FROM shipping_labels WHERE id=?").bind(row.label_id).first();
    return { status: 200, label, already: true };
  }
  if (row.status === "buying") return { status: 409, error: "Still buying the label - check again in a moment." };
  if (row.status !== "pending") return { status: 410, error: row.status === "refunded" ? `Label not bought; refunded. ${row.error || ""}`.trim() : row.status === "expired" ? "That checkout expired. Buy the label again." : "There's a problem with this label payment; we'll sort it out.", state: row.status };
  const s = await stripe(env, "GET", `/v1/checkout/sessions/${row.session_id}`);
  if (s.payment_status !== "paid") {
    if (s.status === "expired") { await setRow(db, row.id, { status: "expired" }); return { status: 410, error: "That checkout expired. Buy the label again.", state: "expired" }; }
    return { status: 402, error: "Payment isn't finished yet.", state: "unpaid" };
  }
  // Claim it: only one caller gets to buy.
  const claim = await db.prepare("UPDATE label_payments SET status='buying', payment_intent=?, updated_at=? WHERE id=? AND status='pending'").bind(s.payment_intent || null, nowIso(), row.id).run();
  if (!claim.meta || claim.meta.changes !== 1) return { status: 409, error: "Still buying the label - check again in a moment." };
  row.payment_intent = s.payment_intent;
  // Price check first: a failure here is before Shippo charges anything, so a refund is safe.
  let live = null;
  try { live = await labels.rateCents(env, row.rate_id); } catch {}
  if (!live || live.cents !== row.label_cents) return refund(env, db, row, stripe, "The label price changed or the rate expired before it could be bought.");
  let r;
  try { r = await buy(row); }
  catch (e) {
    // Unknown whether Shippo made the label: don't refund blind, flag it for a look.
    await setRow(db, row.id, { status: "stuck", error: String(e.message || e) });
    return { status: 502, error: "Paid, but the label didn't come back. We'll send the label or refund you.", stuck: true };
  }
  if (r.error) return refund(env, db, row, stripe, `Label not bought: ${r.error}`);
  await db.prepare("UPDATE shipping_labels SET payer='paid' WHERE id=?").bind(r.label.id).run();
  await setRow(db, row.id, { status: "bought", label_id: r.label.id });
  return { ...r, status: 200 };
}

/** Cron: finish checkouts paid but never returned to (tab closed after paying). */
export async function sweep(env, db, stripe, buyFor, nowMs = Date.now()) {
  const cutoff = new Date(nowMs - 10 * 60 * 1000).toISOString();
  const { results } = await db.prepare("SELECT id, user_id FROM label_payments WHERE status='pending' AND created_at<? LIMIT 10").bind(cutoff).all();
  const out = [];
  for (const p of results || []) {
    try { out.push({ id: p.id, ...(await finishPay(env, db, p.user_id, p.id, stripe, buyFor(p.user_id), nowMs)) }); }
    catch (e) { out.push({ id: p.id, error: String(e.message || e) }); }
  }
  return out;
}

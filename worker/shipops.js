// Shipping ops around a bought label:
//   - void a label (Shippo refunds unused labels; a card-paid label's card is refunded once Shippo
//     confirms the refund - never before, because a label that was already scanned is refused)
//   - book a free USPS carrier pickup for it
//   - ship-by reminders (eBay's handling deadline; garage ship orders left 2 days)
//   - money-safety alerts to the house (stuck label payments, voids Shippo refused, Shippo cap)

import * as labels from "./labels.js";
import * as labelpay from "./labelpay.js";
import { sendAlert } from "./notify.js";

export const VOID_DAYS = 28;   // USPS takes refund requests for 30 days; leave margin
export const LOCATIONS = ["Front Door", "Back Door", "Side Door", "Knock on Door", "Ring Bell", "Mail Room", "Office", "Reception", "In/At Mailbox", "Other"];

export const adminEmail = env => env.ADMIN_EMAIL || String(env.LABEL_USERS || "").split(",")[0].trim() || null;
const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
const money = c => "$" + (Number(c || 0) / 100).toFixed(2);

/** Records a one-off event; true only the first time (so an alert goes out once). */
export async function flagOnce(db, key, ms = Date.now()) {
  const r = await db.prepare("INSERT OR IGNORE INTO ops_flags (key, at) VALUES (?, ?)").bind(key, nowIso(ms)).run();
  return !!(r.meta && r.meta.changes === 1);
}

// ---------------------------------------------------------------- void

export const canVoid = (l, ms = Date.now()) => !!l && !l.void_of && ms - Date.parse(l.created_at) < VOID_DAYS * 86400e3;

/** The open label for an order (not voided). */
export const labelFor = (db, userId, kind, orderId) =>
  db.prepare("SELECT * FROM shipping_labels WHERE user_id=? AND kind=? AND order_id=?").bind(userId, kind, String(orderId || "")).first();

async function refundCardFor(env, db, label, stripe) {
  const p = await db.prepare("SELECT * FROM label_payments WHERE label_id=? AND status='bought'").bind(label.id).first();
  if (!p || !p.payment_intent) { await db.prepare("UPDATE shipping_labels SET card_refund_id='none' WHERE id=?").bind(label.id).run(); return null; }
  // The label (and our fee) comes back; Stripe keeps its card processing fee, so that part doesn't.
  const amount = p.label_cents + p.fee_cents;
  const re = await stripe(env, "POST", "/v1/refunds", { payment_intent: p.payment_intent, amount, metadata: { label_payment: p.id, void: label.id } });
  await db.prepare("UPDATE shipping_labels SET card_refund_id=? WHERE id=?").bind(re.id, label.id).run();
  await db.prepare("UPDATE label_payments SET status='voided', updated_at=? WHERE id=?").bind(nowIso(), p.id).run();
  return { id: re.id, amount };
}

/**
 * Void the order's label. `envFor(label)` gives the Shippo env that paid for it (the seller's own
 * account, or the house). Garage orders reopen so a new label can be bought; eBay keeps the order
 * as shipped (eBay already has the tracking - the seller updates it there).
 */
export async function voidLabel(env, db, userId, kind, orderId, envFor, stripe, ms = Date.now()) {
  const l = await labelFor(db, userId, kind, orderId);
  if (!l) return { status: 404, error: "No label for this order." };
  if (!canVoid(l, ms)) return { status: 409, error: `Labels can only be voided within ${VOID_DAYS} days.` };
  const se = await envFor(l);
  if (!se) return { status: 409, error: "Reconnect your Shippo account to void this label." };
  const r = await labels.shippoApi(se, "POST", "/refunds/", { transaction: l.transaction_id, async: false });
  const st = String(r.status || "").toUpperCase();
  if (st === "ERROR" || !r.object_id) {
    const why = (r.messages || []).map(m => m.text || m).filter(Boolean).join(" ") || "it may already have been used";
    return { status: 409, error: `Shippo wouldn't void it: ${why}` };
  }
  await db.prepare("UPDATE shipping_labels SET order_id=?, void_of=?, void_refund_id=?, void_status=?, voided_at=? WHERE id=?")
    .bind(`${l.order_id}~void~${l.id}`, l.order_id, r.object_id, st, nowIso(ms), l.id).run();
  let reopened = false;
  if (kind === "garage") {
    const u = await db.prepare("UPDATE garage_orders SET status='paid', tracking=NULL, updated_at=? WHERE id=? AND status='fulfilled'").bind(nowIso(ms), l.order_id).run();
    reopened = !!(u.meta && u.meta.changes);
  }
  let card = null;
  if (l.payer === "paid" && st === "SUCCESS") card = await refundCardFor(env, db, { ...l }, stripe);
  return { status: 200, void_status: st, reopened, card_refund: card,
           note: l.payer === "paid" ? (card ? `Refunded ${money(card.amount)} to your card.` : "Your card is refunded once Shippo confirms (usually within 2 weeks).") : null };
}

/** Cron: follow pending voids; refund the card when Shippo refunds; flag refusals. */
export async function checkVoids(env, db, envFor, stripe, ms = Date.now()) {
  const { results } = await db.prepare("SELECT * FROM shipping_labels WHERE void_status IN ('QUEUED','PENDING') OR (void_status='SUCCESS' AND payer='paid' AND card_refund_id IS NULL) LIMIT 20").all();
  const out = [];
  for (const l of results || []) {
    try {
      let st = l.void_status;
      if (st !== "SUCCESS") {
        const se = await envFor(l);
        if (!se) { out.push({ id: l.id, skipped: "no shippo env" }); continue; }
        st = String((await labels.shippoApi(se, "GET", `/refunds/${l.void_refund_id}`)).status || st).toUpperCase();
        if (st !== l.void_status) await db.prepare("UPDATE shipping_labels SET void_status=? WHERE id=?").bind(st, l.id).run();
      }
      if (st === "SUCCESS" && l.payer === "paid" && !l.card_refund_id) await refundCardFor(env, db, l, stripe);
      if (st === "ERROR" && await flagOnce(db, `void-error-${l.id}`, ms)) {
        const to = adminEmail(env);
        if (to) await sendAlert(env, { to, subject: `Guestimator: Shippo refused a label void (${l.tracking || l.id})`,
          text: `Shippo refused to refund a voided label.\n\nLabel ${l.id}\nOrder ${l.void_of} (${l.kind})\nTracking ${l.tracking}\n${l.service} ${money(l.amount_cents)}\nPaid by: ${l.payer || "house"}\n\nThe seller was not refunded. Check it in Shippo.` });
      }
      out.push({ id: l.id, status: st });
    } catch (e) { out.push({ id: l.id, error: String(e.message || e) }); }
  }
  return out;
}

// ---------------------------------------------------------------- USPS pickup

/** The next 3 days USPS picks up (Mon-Sat), as YYYY-MM-DD, starting tomorrow (US Eastern day). */
export function pickupDays(ms = Date.now()) {
  const out = []; let d = new Date(ms - 5 * 3600e3);   // close enough to a US calendar day
  while (out.length < 3) {
    d = new Date(d.getTime() + 86400e3);
    if (d.getUTCDay() !== 0) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const digits = s => String(s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/**
 * Book a free USPS carrier pickup for the order's label. `from` is the seller's saved return
 * address (where USPS comes), `email` theirs. b = { date, location, instructions, phone }.
 */
export async function bookPickup(se, db, userId, kind, orderId, b, from, email, ms = Date.now()) {
  const l = await labelFor(db, userId, kind, orderId);
  if (!l) return { status: 404, error: "No label for this order." };
  if (l.carrier !== "USPS") return { status: 409, error: "Free pickup is for USPS labels." };
  let had = null; try { had = l.pickup ? JSON.parse(l.pickup) : null; } catch {}
  if (had && had.status !== "ERROR") return { status: 409, error: "A pickup is already booked for this label.", pickup: had };
  if (!pickupDays(ms).includes(b.date)) return { status: 400, error: "Pick one of the offered days." };
  if (!LOCATIONS.includes(b.location)) return { status: 400, error: "Where should the carrier find the package?" };
  const instructions = String(b.instructions || "").trim().slice(0, 100);
  if (b.location === "Other" && !instructions) return { status: 400, error: "Say where the package will be." };
  if (!from) return { status: 409, error: "Add your return address first." };
  const phone = digits(b.phone || from.phone);
  if (phone.length !== 10) return { status: 400, error: "USPS needs a 10-digit phone number for pickups.", needs_phone: true };
  const rate = await labels.shippoApi(se, "GET", `/rates/${l.rate_id}`);
  if (!rate.carrier_account) return { status: 502, error: "Couldn't find the USPS account for this label." };
  const p = await labels.shippoApi(se, "POST", "/pickups/", {
    carrier_account: rate.carrier_account,
    location: { building_location_type: b.location, instructions,
                address: { name: from.name, street1: from.street1, street2: from.street2 || "", city: from.city, state: from.state, zip: from.zip, country: "US", phone, email } },
    transactions: [l.transaction_id],
    requested_start_time: `${b.date}T13:00:00Z`, requested_end_time: `${b.date}T23:00:00Z`,
    metadata: `guestimator ${l.id}`,
  });
  const st = String(p.status || "").toUpperCase();
  if (st === "ERROR" || !p.object_id) {
    const why = (p.messages || []).map(m => m.text || m).filter(Boolean).join(" ") || "USPS didn't accept it";
    return { status: 409, error: `Pickup not booked: ${why}` };
  }
  const pickup = { id: p.object_id, status: st, confirmation: p.confirmation_code || null, date: b.date,
                   start: p.confirmed_start_time || null, end: p.confirmed_end_time || null, tz: p.timezone || null, location: b.location };
  await db.prepare("UPDATE shipping_labels SET pickup=? WHERE id=?").bind(JSON.stringify(pickup), l.id).run();
  return { status: 200, pickup };
}

// ---------------------------------------------------------------- ship-by reminders

export const REMIND_BEFORE_H = 30;   // eBay ship-by within this many hours (or past) -> remind
export const GARAGE_WAIT_H = 48;     // garage ship order still unshipped this long after payment
export const FRESH_SALE_H = 12;     // the "Sold on eBay" email already gave the ship-by date

const noLabel = alias => `NOT EXISTS (SELECT 1 FROM shipping_labels s WHERE s.kind='${alias === "e" ? "ebay" : "garage"}' AND s.order_id=${alias}.id)`;

/** Cron: one reminder per unshipped order that's due. Marks first so it can't double-send. */
export async function shipReminders(env, db, origin, ms = Date.now()) {
  const sent = [];
  const soon = nowIso(ms + REMIND_BEFORE_H * 3600e3);
  const eb = (await db.prepare(
    `SELECT e.id, e.ship_by, e.title, u.email, COALESCE(i.ai_title, i.name, e.title) AS item_title FROM ebay_orders e JOIN users u ON u.id=e.user_id LEFT JOIN items i ON i.id=e.item_id
      WHERE e.status IN ('NOT_STARTED','IN_PROGRESS') AND e.ship_by IS NOT NULL AND e.ship_by<=? AND e.created_at<=? AND e.ship_reminded_at IS NULL AND ${noLabel("e")} LIMIT 50`).bind(soon, nowIso(ms - FRESH_SALE_H * 3600e3)).all()).results || [];
  for (const o of eb) {
    const m = await db.prepare("UPDATE ebay_orders SET ship_reminded_at=? WHERE id=? AND ship_reminded_at IS NULL").bind(nowIso(ms), o.id).run();
    if (!(m.meta && m.meta.changes)) continue;
    const late = Date.parse(o.ship_by) < ms, day = String(o.ship_by).slice(0, 10);
    const subject = late ? `Overdue: ship ${o.item_title || "your eBay sale"} today` : `Ship by ${day}: ${o.item_title || "your eBay sale"}`;
    await sendAlert(env, { to: o.email, subject,
      text: `${late ? `eBay's ship-by date (${day}) has passed.` : `eBay expects this to ship by ${day}.`} Late shipments count against your seller rating.\n\nBuy the label and print it here:\n${origin}/#ebay-orders` });
    sent.push({ kind: "ebay", id: o.id, late });
  }
  const before = nowIso(ms - GARAGE_WAIT_H * 3600e3);
  const ga = (await db.prepare(
    `SELECT o.id, o.created_at, u.email, s.title AS sale_title, COALESCE(i.ai_title, i.name) AS item_title FROM garage_orders o JOIN garage_sales s ON s.id=o.sale_id JOIN users u ON u.id=s.user_id
       LEFT JOIN items i ON i.id=o.item_id
      WHERE o.status='paid' AND o.fulfilment='ship' AND o.created_at<=? AND o.ship_reminded_at IS NULL AND ${noLabel("o")} LIMIT 50`).bind(before).all()).results || [];
  for (const o of ga) {
    const m = await db.prepare("UPDATE garage_orders SET ship_reminded_at=? WHERE id=? AND ship_reminded_at IS NULL").bind(nowIso(ms), o.id).run();
    if (!(m.meta && m.meta.changes)) continue;
    await sendAlert(env, { to: o.email, subject: `Still to ship: ${o.item_title || "an item"} (${o.sale_title})`,
      text: `A buyer paid for ${o.item_title || "an item"} from ${o.sale_title} ${Math.floor((ms - Date.parse(o.created_at)) / 86400e3)} days ago and it hasn't shipped yet.\n\nBuy the label and print it here:\n${origin}/` });
    sent.push({ kind: "garage", id: o.id });
  }
  return sent;
}

// ---------------------------------------------------------------- money-safety alerts

export const STUCK_BUYING_MIN = 15;

/** Cron: tell the house about label payments that went wrong, and the Shippo plan filling up. */
export async function moneyAlerts(env, db, ms = Date.now()) {
  const to = adminEmail(env), out = { stuck: 0, cap: null };
  // A buy that never finished (worker died mid-call): not knowable whether Shippo made it.
  await db.prepare("UPDATE label_payments SET status='stuck', error=COALESCE(error,'interrupted while buying'), updated_at=? WHERE status='buying' AND updated_at<?")
    .bind(nowIso(ms), nowIso(ms - STUCK_BUYING_MIN * 60e3)).run();
  const stuck = (await db.prepare("SELECT p.*, u.email FROM label_payments p JOIN users u ON u.id=p.user_id WHERE p.status='stuck' AND p.alerted_at IS NULL LIMIT 20").all()).results || [];
  if (stuck.length && to) {
    await sendAlert(env, { to, subject: `Guestimator: ${stuck.length} label payment${stuck.length === 1 ? "" : "s"} need a look`,
      text: "Paid by card, but no label and no automatic refund. Check Shippo for a label on these orders; if there is none, refund the payment in Stripe.\n\n" +
        stuck.map(p => `- ${p.email}: ${p.kind} order ${p.order_id}, ${money(p.total_cents)} (label ${money(p.label_cents)}), Stripe ${p.payment_intent || p.session_id}\n  ${p.error || ""}`).join("\n") });
  }
  for (const p of stuck) await db.prepare("UPDATE label_payments SET alerted_at=? WHERE id=?").bind(nowIso(ms), p.id).run();
  out.stuck = stuck.length;
  // Shippo plan cap: warn 5 before, and when full. Once each per month.
  const used = await labelpay.monthCount(db, ms), cap = labelpay.houseCap(env), mon = labelpay.monthStart(ms).slice(0, 7);
  const level = used >= cap ? "full" : used >= Math.max(1, cap - 5) ? "warn" : null;
  if (level && to && await flagOnce(db, `cap-${level}-${mon}`, ms)) {
    await sendAlert(env, { to, subject: level === "full" ? `Guestimator: Shippo label cap reached (${used}/${cap})` : `Guestimator: ${used} of ${cap} Shippo labels used this month`,
      text: (level === "full" ? "Sellers can't buy labels through Guestimator until the 1st." : `${cap - used} labels left this month.`) +
        " To lift it, upgrade the Shippo plan and raise SHIPPO_MONTHLY_CAP in wrangler.jsonc, then redeploy." });
    out.cap = level;
  }
  return out;
}

import { packageFor } from "./packing.js";
// Buy a shipping label for an online order (garage-sale or eBay) through Shippo, then mark the
// order shipped with the label's tracking number - which emails a garage buyer, or tells eBay.
//
// Money: labels are charged to the Shippo account behind SHIPPO_API_TOKEN (Derek's), so buying
// is only switched on for the accounts listed in LABEL_USERS. Everyone else still gets rates.

import { pickRates, zip5 } from "./shipping.js";
import * as ebayOrders from "./ebayorders.js";

const SHIPPO = "https://api.goshippo.com";
const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR".split(" "));

export const labelsOn = (env, email) =>
  !!env.SHIPPO_API_TOKEN && String(env.LABEL_USERS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean).includes(String(email || "").toLowerCase());

// The return address the seller saves once. Everything USPS needs to accept a label.
export function cleanFrom(b) {
  const s = k => String((b && b[k]) || "").trim();
  const f = { name: s("name").slice(0, 60), street1: s("street1").slice(0, 80), street2: s("street2").slice(0, 80),
              city: s("city").slice(0, 50), state: s("state").toUpperCase().slice(0, 2), zip: zip5(s("zip")) || "", phone: s("phone").replace(/[^\d+]/g, "").slice(0, 15) };
  if (!f.name || !f.street1 || !f.city) return { error: "Name, street and city are needed for the return address." };
  if (!STATES.has(f.state)) return { error: "Use the 2-letter state, like NJ." };
  if (!f.zip) return { error: "Enter a 5-digit ZIP." };
  return { value: f };
}

// Buyer address as we store it (Stripe Checkout / eBay shipTo, {name, phone, address:{...}}) -> Shippo.
export function toAddress(json) {
  let a = null; try { a = typeof json === "string" ? JSON.parse(json || "null") : json; } catch {}
  const d = a && a.address;
  if (!d || !d.line1 || !d.city || !d.postal_code) return null;
  return { name: a.name || "", street1: d.line1, street2: d.line2 || "", city: d.city, state: d.state || "",
           zip: d.postal_code, country: d.country || "US", phone: a.phone || "" };
}
const fromAddress = f => ({ name: f.name, street1: f.street1, street2: f.street2 || "", city: f.city, state: f.state, zip: f.zip, country: "US", phone: f.phone || "" });

// The estimated box unless the seller typed the real one (they should: they've weighed it now).
export function parcelFor(est, over) {
  // Without the seller's own measurements, the stock box or mailer packageFor picks.
  const pk = packageFor(est);
  const box = (over && Array.isArray(over.box_in) && over.box_in.length === 3 ? over.box_in : pk ? pk.box_in : est && est.box_in || []).map(Number);
  const lb = Number(over && over.weight_lb) || Number(pk && pk.weight_lb) || Number(est && est.packed_weight_lb);
  if (box.length !== 3 || box.some(n => !(n > 0 && n <= 108)) || !(lb > 0 && lb <= 150)) return null;
  return { length: String(box[0]), width: String(box[1]), height: String(box[2]), distance_unit: "in", weight: String(Math.round(lb * 100) / 100), mass_unit: "lb" };
}

// eBay wants USPS / UPS / FedEx; Shippo's provider names match apart from case.
export const carrierOf = p => ({ usps: "USPS", ups: "UPS", fedex: "FedEx" })[String(p || "").toLowerCase()] || null;

async function shippo(env, method, path, body) {
  const r = await fetch(SHIPPO + path, { method, headers: { authorization: `ShippoToken ${env.SHIPPO_API_TOKEN}`, "content-type": "application/json" },
                                         body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j && (j.detail || j.message || JSON.stringify(j).slice(0, 200))) || `Shippo ${r.status}`), { status: 502 });
  return j;
}

// Which order, whose, and where it goes. Only open, shippable, paid orders.
export async function orderFor(db, userId, kind, orderId) {
  if (kind === "garage") {
    const o = await db.prepare("SELECT o.* FROM garage_orders o JOIN garage_sales s ON s.id=o.sale_id WHERE o.id=? AND s.user_id=?").bind(orderId, userId).first();
    if (!o) return { status: 404, error: "not found" };
    if (o.fulfilment !== "ship") return { status: 409, error: "This order is a pickup." };
    if (o.status !== "paid") return { status: 409, error: o.status === "fulfilled" ? "Already shipped." : "Only a paid order can be shipped." };
    return { order: o, itemId: o.item_id, to: toAddress(o.ship_address) };
  }
  if (kind === "ebay") {
    const o = await db.prepare("SELECT * FROM ebay_orders WHERE id=? AND user_id=?").bind(orderId, userId).first();
    if (!o) return { status: 404, error: "not found" };
    if (!["NOT_STARTED", "IN_PROGRESS"].includes(o.status)) return { status: 409, error: o.status === "CANCELLED" ? "This order was cancelled." : "Already shipped." };
    return { order: o, itemId: o.item_id, to: toAddress(o.ship_to) };
  }
  return { status: 400, error: "unknown order kind" };
}

/** Real rates to this buyer's address, cheapest first. */
export async function labelRates(env, from, to, parcel, flat = []) {
  const j = await shippo(env, "POST", "/shipments/", { address_from: fromAddress(from), address_to: to, parcels: [parcel], async: false });
  const rates = Object.values(pickRates(j.rates));
  // USPS Flat Rate options the item fits (packing.flatRateFits): each is its own shipment, and its
  // Priority rate is the Flat Rate price. A failed one is just left out.
  for (const f of flat || []) {
    try {
      const fj = await shippo(env, "POST", "/shipments/", { address_from: fromAddress(from), address_to: to, async: false,
        parcels: [{ template: f.template, weight: String(f.weight_lb), mass_unit: "lb" }] });
      const pr = pickRates(fj.rates).usps_priority;
      if (pr) rates.push({ ...pr, service: `USPS Priority Mail ${f.name}`, flat_rate: f.template });
    } catch {}
  }
  rates.sort((a, b) => a.amount - b.amount);
  const why = (j.messages || []).map(m => m.text).filter(Boolean).slice(0, 2).join(" ");
  return { rates, note: rates.length ? null : why || "No carrier returned a rate for that address and box." };
}

/**
 * Buy the label for `rateId`. `expectCents` is the price the seller saw: if Shippo's rate says
 * otherwise, nothing is bought. Returns the saved label; marks the order shipped.
 */
export async function buyLabel(env, db, userId, kind, orderId, rateId, expectCents, fileType, origin, ctx, shippedEmail) {
  const t = await orderFor(db, userId, kind, orderId);
  if (t.error) return t;
  const had = await db.prepare("SELECT * FROM shipping_labels WHERE kind=? AND order_id=?").bind(kind, orderId).first();
  if (had) return { status: 409, error: "A label was already bought for this order.", label: had };
  if (!/^[a-f0-9]{32}$/i.test(String(rateId || ""))) return { status: 400, error: "Pick a rate first." };
  const rate = await shippo(env, "GET", `/rates/${rateId}`);
  const cents = Math.round(Number(rate.amount) * 100);
  if (!(cents > 0) || Math.abs(cents - Number(expectCents)) > 0) return { status: 409, error: "That price changed. Get rates again." };
  const tx = await shippo(env, "POST", "/transactions/", { rate: rateId, async: false, label_file_type: fileType === "PDF" ? "PDF" : "PDF_4x6" });
  if (tx.status !== "SUCCESS" || !tx.label_url) {
    const msg = (tx.messages || []).map(m => m.text).filter(Boolean).join(" ") || `Shippo said ${tx.status || "no"}`;
    return { status: 502, error: `Label not bought: ${msg}` };
  }
  const carrier = carrierOf(rate.provider);
  const label = { id: crypto.randomUUID(), user_id: userId, kind, order_id: orderId, transaction_id: tx.object_id, rate_id: rateId, carrier,
                  service: rate.servicelevel?.name ? `${rate.provider} ${rate.servicelevel.name}` : rate.provider, amount_cents: cents,
                  tracking: tx.tracking_number || null, label_url: tx.label_url, created_at: new Date().toISOString() };
  await db.prepare("INSERT INTO shipping_labels (id,user_id,kind,order_id,transaction_id,rate_id,carrier,service,amount_cents,tracking,label_url,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(label.id, userId, kind, orderId, label.transaction_id, rateId, carrier, label.service, cents, label.tracking, label.label_url, label.created_at).run();
  // Bought = on its way. Mark it shipped so the tracking reaches the buyer.
  let shipped = null;
  if (kind === "garage") {
    await db.prepare("UPDATE garage_orders SET status='fulfilled', tracking=?, updated_at=? WHERE id=?").bind(label.tracking, label.created_at, orderId).run();
    if (ctx && ctx.waitUntil && shippedEmail) ctx.waitUntil(shippedEmail(db, env, orderId, origin).catch(e => console.log("buyerShippedEmail", e)));
    shipped = { ok: true };
  } else {
    shipped = await ebayOrders.markShipped(env, db, userId, orderId, label.tracking, carrier);
  }
  return { status: 200, label, shipped: !!shipped.ok, shipped_error: shipped.ok ? null : shipped.error };
}

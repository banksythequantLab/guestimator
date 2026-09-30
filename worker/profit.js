// What each sale actually made: sale price and shipping the buyer paid, minus marketplace fees,
// the label, and what the seller paid for the item. Three kinds of sale are counted:
//   eBay            - ebay_orders (eBay's own totals and fee)
//   Online (sale)   - garage_orders paid through Stripe (our platform fee; Stripe's card fee is
//                     estimated at 2.9% + 30c because it is charged on the seller's own account)
//   At the sale     - garage_sale_items marked sold in person, at the tag price
// A figure we can't know is null, and the row says so, rather than a guess dressed as a fact.

export const STRIPE_EST = c => Math.round(c * 0.029) + 30;

const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to + "T99");

export async function profitRows(db, userId, { from = "", to = "" } = {}) {
  const rows = [];
  const title = "COALESCE(i.ai_title, i.name)";
  const eb = (await db.prepare(
    `SELECT e.id, e.item_id, e.ordered_at AS at, e.total_cents, e.ship_paid_cents, e.fee_cents, ${title} AS title,
            (SELECT amount_cents FROM shipping_labels s WHERE s.kind='ebay' AND s.order_id=e.id) AS label_cents
       FROM ebay_orders e LEFT JOIN items i ON i.id=e.item_id WHERE e.user_id=? AND e.status<>'CANCELLED'`).bind(userId).all()).results;
  for (const r of eb) rows.push({
    channel: "eBay", ref: r.id, item_id: r.item_id, title: r.title, at: r.at,
    sale_cents: r.total_cents != null && r.ship_paid_cents != null ? r.total_cents - r.ship_paid_cents : r.total_cents,
    ship_paid_cents: r.ship_paid_cents, fee_cents: r.fee_cents, fee_note: r.fee_cents == null ? "eBay fee not reported yet" : "eBay fee",
    label_cents: r.label_cents });

  const go = (await db.prepare(
    `SELECT o.id, o.item_id, o.updated_at AS at, o.item_cents, o.ship_cents, o.fee_cents, o.total_cents, ${title} AS title,
            (SELECT amount_cents FROM shipping_labels s WHERE s.kind='garage' AND s.order_id=o.id) AS label_cents
       FROM garage_orders o JOIN garage_sales g ON g.id=o.sale_id LEFT JOIN items i ON i.id=o.item_id
      WHERE g.user_id=? AND o.status IN ('paid','fulfilled')`).bind(userId).all()).results;
  for (const r of go) rows.push({
    channel: "Online (sale page)", ref: r.id, item_id: r.item_id, title: r.title, at: r.at,
    sale_cents: r.item_cents, ship_paid_cents: r.ship_cents || 0,
    fee_cents: (r.fee_cents || 0) + STRIPE_EST(r.total_cents), fee_note: "Guestimator fee + Stripe card fee (estimated)",
    label_cents: r.label_cents });

  // In person: sold on a sale page with no paid online order and no eBay sale behind it.
  const ip = (await db.prepare(
    `SELECT gi.item_id, gi.sold_at AS at, gi.price_cents, ${title} AS title
       FROM garage_sale_items gi JOIN garage_sales g ON g.id=gi.sale_id LEFT JOIN items i ON i.id=gi.item_id
      WHERE g.user_id=? AND gi.status='sold'
        AND NOT EXISTS (SELECT 1 FROM garage_orders o WHERE o.item_id=gi.item_id AND o.status IN ('paid','fulfilled'))
        AND NOT EXISTS (SELECT 1 FROM ebay_orders e WHERE e.item_id=gi.item_id AND e.status<>'CANCELLED')`).bind(userId).all()).results;
  for (const r of ip) rows.push({
    channel: "At the sale", ref: r.item_id, item_id: r.item_id, title: r.title, at: r.at,
    sale_cents: r.price_cents, ship_paid_cents: 0, fee_cents: 0, fee_note: "tag price, cash or card in person", label_cents: null });

  const costs = new Map((await db.prepare("SELECT item_id, cost_cents FROM item_finance WHERE user_id=?").bind(userId).all()).results
    .map(c => [c.item_id, c.cost_cents]));
  const out = rows.filter(r => r.at && inRange(r.at, from, to)).map(r => {
    const cost = costs.has(r.item_id) ? costs.get(r.item_id) : null;
    const known = r.sale_cents != null;
    const profit = known ? r.sale_cents + (r.ship_paid_cents || 0) - (r.fee_cents || 0) - (r.label_cents || 0) - (cost || 0) : null;
    return { ...r, cost_cents: cost, profit_cents: profit, missing_cost: cost == null };
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const sum = k => out.reduce((t, r) => t + (r[k] || 0), 0);
  return {
    rows: out,
    totals: { sales: out.length, sale_cents: sum("sale_cents"), ship_paid_cents: sum("ship_paid_cents"), fee_cents: sum("fee_cents"),
              label_cents: sum("label_cents"), cost_cents: sum("cost_cents"), profit_cents: sum("profit_cents"),
              missing_cost: out.filter(r => r.missing_cost).length },
  };
}

// Unsold stock: what it's estimated to be worth and what it cost.
export async function inventorySummary(db, userId) {
  const items = (await db.prepare(
    `SELECT i.id, (SELECT result_json FROM appraisals a WHERE a.item_id=i.id AND a.status='done' ORDER BY a.created_at DESC LIMIT 1) AS rj,
            f.cost_cents
       FROM items i JOIN sales s ON s.id=i.sale_id LEFT JOIN item_finance f ON f.item_id=i.id
      WHERE s.user_id=? AND i.listing_status<>'sold'
        AND NOT EXISTS (SELECT 1 FROM garage_sale_items gi WHERE gi.item_id=i.id AND gi.status='sold')
        AND NOT EXISTS (SELECT 1 FROM ebay_orders e WHERE e.item_id=i.id AND e.status<>'CANCELLED')`).bind(userId).all()).results;
  let est = 0, priced = 0, cost = 0;
  for (const it of items) {
    let v = null; try { v = JSON.parse(it.rj || "null")?.price_range?.suggested_retail ?? null; } catch {}
    if (Number(v) > 0) { est += Math.round(v * 100); priced++; }
    cost += it.cost_cents || 0;
  }
  return { items: items.length, priced, estimate_cents: est, cost_cents: cost };
}

const csvCell = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const dollars = c => (c == null ? "" : (c / 100).toFixed(2));
export function profitCsv(rep) {
  const head = ["Date", "Channel", "Item", "Sale price", "Shipping paid by buyer", "Fees", "Fee note", "Label", "Your cost", "Profit"];
  const lines = rep.rows.map(r => [String(r.at).slice(0, 10), r.channel, r.title, dollars(r.sale_cents), dollars(r.ship_paid_cents), dollars(r.fee_cents),
    r.fee_note, dollars(r.label_cents), dollars(r.cost_cents), dollars(r.profit_cents)]);
  const t = rep.totals;
  lines.push(["", "TOTAL", `${t.sales} sales`, dollars(t.sale_cents), dollars(t.ship_paid_cents), dollars(t.fee_cents), "", dollars(t.label_cents), dollars(t.cost_cents), dollars(t.profit_cents)]);
  return [head, ...lines].map(l => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

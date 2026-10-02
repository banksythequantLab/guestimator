// Tax-time summary: one printable page per year - gross receipts, fees, shipping and cost of
// goods by channel - for a 1099-K reconciliation or an accountant. Built from the profit report's
// rows, so the two never disagree. It summarises what Guestimator recorded; it is not tax advice.

import { profitRows } from "./profit.js";

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = c => (c < 0 ? "-$" : "$") + (Math.abs(c || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function taxSummary(db, userId, year) {
  const y = Number(year);
  const rep = await profitRows(db, userId, { from: `${y}-01-01`, to: `${y}-12-31` });
  const by = {};
  for (const r of rep.rows) {
    const c = by[r.channel] || (by[r.channel] = { channel: r.channel, sales: 0, gross_cents: 0, item_cents: 0, ship_paid_cents: 0, fee_cents: 0, label_cents: 0, cost_cents: 0, missing_cost: 0 });
    c.sales++;
    c.item_cents += r.sale_cents || 0;
    c.ship_paid_cents += r.ship_paid_cents || 0;
    c.gross_cents += (r.sale_cents || 0) + (r.ship_paid_cents || 0);
    c.fee_cents += r.fee_cents || 0;
    c.label_cents += r.label_cents || 0;
    c.cost_cents += r.cost_cents || 0;
    if (r.missing_cost) c.missing_cost++;
  }
  const channels = Object.values(by).map(c => ({ ...c, net_cents: c.gross_cents - c.fee_cents - c.label_cents - c.cost_cents }));
  const sum = k => channels.reduce((t, c) => t + c[k], 0);
  const keys = ["sales", "gross_cents", "item_cents", "ship_paid_cents", "fee_cents", "label_cents", "cost_cents", "net_cents", "missing_cost"];
  return { year: y, channels, totals: Object.fromEntries(keys.map(k => [k, sum(k)])), rows: rep.rows };
}

export function taxPage(t, who) {
  const row = c => `<tr><td>${esc(c.channel)}</td><td class="r">${c.sales}</td><td class="r">${money(c.gross_cents)}</td><td class="r">${money(c.fee_cents)}</td>
    <td class="r">${money(c.label_cents)}</td><td class="r">${money(c.cost_cents)}</td><td class="r"><b>${money(c.net_cents)}</b></td></tr>`;
  const T = t.totals;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${t.year} selling summary</title>
<style>@page{size:letter;margin:.6in}body{font-family:system-ui,sans-serif;color:#1d2521;margin:0}.bar{padding:12px;background:#0f6b59;color:#fff}.bar a,.bar button{font:600 14px system-ui;padding:6px 10px;border-radius:8px;border:0;margin:2px;background:#fff;color:#0f6b59;text-decoration:none}
.pg{max-width:7.3in;margin:0 auto;padding:.3in}h1{font:700 1.5rem Georgia,serif;margin:0}table{width:100%;border-collapse:collapse;margin:.2in 0;font-size:.88rem}th,td{padding:6px 4px;border-bottom:1px solid #ddd;text-align:left}.r{text-align:right}
tfoot td{font-weight:700;border-top:2px solid #1d2521}.m{color:#6b7772;font-size:.8rem;line-height:1.45}@media print{.bar{display:none}}</style></head>
<body><div class="bar">${t.year} selling summary · <a href="?year=${t.year - 1}">${t.year - 1}</a> <a href="?year=${t.year + 1}">${t.year + 1}</a>
<a href="/api/profit/csv?from=${t.year}-01-01&to=${t.year}-12-31">Download every sale (CSV)</a> <button onclick="print()">Print / save PDF</button></div><div class="pg">
<h1>${t.year} selling summary</h1><div class="m">${esc(who)} · from Guestimator's records · ${T.sales} sale${T.sales === 1 ? "" : "s"}</div>
<table><thead><tr><th>Channel</th><th class="r">Sales</th><th class="r">Gross received</th><th class="r">Platform fees</th><th class="r">Labels</th><th class="r">Cost of items</th><th class="r">Net</th></tr></thead>
<tbody>${t.channels.map(row).join("") || `<tr><td colspan="7" class="m">No sales recorded for ${t.year}.</td></tr>`}</tbody>
<tfoot><tr><td>Total</td><td class="r">${T.sales}</td><td class="r">${money(T.gross_cents)}</td><td class="r">${money(T.fee_cents)}</td><td class="r">${money(T.label_cents)}</td><td class="r">${money(T.cost_cents)}</td><td class="r">${money(T.net_cents)}</td></tr></tfoot></table>
<div class="m"><b>Gross received</b> is the item price plus any shipping the buyer paid. eBay's 1099-K usually reports gross payments including shipping and sales tax eBay collected, so it can be higher than this; the difference is normally the sales tax.
<b>Platform fees</b> are eBay's final value fees as eBay reported them, and an estimate (2.9% + 30¢) of card fees on sale-page orders.
${T.missing_cost ? `<br><b>${T.missing_cost} sale${T.missing_cost === 1 ? " has" : "s have"} no cost entered</b>, so net is overstated for ${T.missing_cost === 1 ? "it" : "them"}. Add what you paid on each item's page.` : ""}
<br>This summarises what Guestimator recorded. It is not tax advice: check it against your eBay and Stripe statements, and ask your accountant how to report it.</div></div></body></html>`;
}
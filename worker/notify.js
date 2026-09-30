// Seller alerts for garage / estate sales: an email when a shopper asks to hold an item and when
// one pays for it online. Without these the seller only finds out by opening the app, and a hold
// request made on Friday night is worthless by Saturday morning.
//
// Sent through Cloudflare Email Service (the `send_email` binding named EMAIL). If the binding is
// missing, or the domain isn't set up for sending yet, the alert is skipped and logged - it never
// breaks the hold or the payment it is reporting on. The in-app badges carry the same news.

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = c => "$" + (Number(c || 0) / 100).toFixed(2);

export async function sendAlert(env, { to, subject, text, html, replyTo }) {
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") return { sent: false, why: "no EMAIL binding" };
  if (!to) return { sent: false, why: "no recipient" };
  const from = { email: env.ALERT_FROM || "alerts@theguestimator.com", name: "Guestimator" };
  try {
    const msg = { to, from, subject, text, html };
    if (replyTo) msg.replyTo = replyTo;
    const r = await env.EMAIL.send(msg);
    return { sent: true, id: r && r.messageId };
  } catch (e) {
    console.log("alert email failed:", subject, String(e && e.message || e));
    return { sent: false, why: String(e && e.message || e) };
  }
}

const shell = (title, rows, link, linkText) => `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f4ecdc;margin:0;padding:24px;color:#241b10">
<div style="max-width:520px;margin:0 auto;background:#fbf6ea;border:1px solid #e0d2b4;border-radius:14px;padding:20px">
<div style="font-weight:800;font-size:18px;margin-bottom:12px">${esc(title)}</div>
<table style="border-collapse:collapse;font-size:14px;width:100%">${rows.filter(r => r[1]).map(([k, v]) =>
  `<tr><td style="padding:4px 12px 4px 0;color:#6a5b44;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0">${esc(v).replace(/\n/g, "<br>")}</td></tr>`).join("")}</table>
<div style="margin-top:16px"><a href="${esc(link)}" style="display:inline-block;background:#241b10;color:#f4ecdc;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:10px">${esc(linkText)}</a></div>
<div style="margin-top:14px;font-size:12px;color:#6a5b44">You're getting this because you run this sale on Guestimator.</div>
</div></body></html>`;
const plain = (title, rows, link) => [title, "", ...rows.filter(r => r[1]).map(([k, v]) => `${k}: ${v}`), "", link].join("\n");

const loadContext = (db, saleId, itemId) => db.prepare(
  `SELECT s.title AS sale_title, s.slug, s.user_id, u.email AS seller_email,
          COALESCE(i.ai_title, i.name) AS item_title
     FROM garage_sales s JOIN users u ON u.id=s.user_id
     LEFT JOIN items i ON i.id=?
    WHERE s.id=?`).bind(itemId, saleId).first();

/** A shopper asked the seller to hold an item. */
export async function holdAlert(db, env, holdId, origin) {
  const h = await db.prepare("SELECT * FROM garage_holds WHERE id=?").bind(holdId).first();
  if (!h) return { sent: false, why: "hold gone" };
  const c = await loadContext(db, h.sale_id, h.item_id);
  if (!c) return { sent: false, why: "sale gone" };
  const title = `Hold request: ${c.item_title || "an item"}`;
  const rows = [["Sale", c.sale_title], ["Item", c.item_title], ["From", h.name], ["Phone", h.phone], ["Note", h.note]];
  const link = `${origin}/#sales`;
  return sendAlert(env, { to: c.seller_email, subject: `${title} - ${c.sale_title}`,
    text: plain(title, rows, link) + "\n\nCall or text them, then accept or decline the hold in the app.",
    html: shell(title, rows, link, "Open my sale") });
}

/** An online order was paid (or paid for something already sold, which needs a refund). */
export async function orderAlert(db, env, orderId, origin) {
  const o = await db.prepare("SELECT * FROM garage_orders WHERE id=?").bind(orderId).first();
  if (!o || !["paid", "refund_needed"].includes(o.status)) return { sent: false, why: "not a paid order" };
  const c = await loadContext(db, o.sale_id, o.item_id);
  if (!c) return { sent: false, why: "sale gone" };
  let addr = null, phone = null;
  try {
    const a = o.ship_address ? JSON.parse(o.ship_address) : null;
    phone = a && a.phone || null;
    const ad = a && a.address;
    if (ad) addr = [a.name, ad.line1, ad.line2, [ad.city, ad.state, ad.postal_code].filter(Boolean).join(" ")].filter(Boolean).join("\n");
  } catch { /* leave blank */ }
  const refund = o.status === "refund_needed";
  const title = refund ? `Refund needed: ${c.item_title || "an item"} was already sold`
                       : `Sold online: ${c.item_title || "an item"}`;
  const rows = [
    ["Sale", c.sale_title], ["Item", c.item_title],
    ["Paid", money(o.total_cents) + (o.ship_cents ? ` (${money(o.item_cents)} + ${money(o.ship_cents)} shipping)` : "")],
    ["Delivery", o.fulfilment === "ship" ? "Ship it" : "Buyer picks up at the sale"],
    ["Buyer", o.buyer_name], ["Email", o.buyer_email], ["Phone", phone],
    ["Ship to", o.fulfilment === "ship" ? addr : null],
    ["Note", refund ? "The item had already been sold at the sale. Refund this buyer from your Stripe dashboard." : null],
  ];
  const link = `${origin}/#sales`;
  return sendAlert(env, { to: c.seller_email, subject: `${title} - ${money(o.total_cents)}`,
    text: plain(title, rows, link) + (o.fulfilment === "ship" && !refund ? "\n\nShip it, then add the tracking number in the app." : ""),
    html: shell(title, rows, link, "Open my sale"), replyTo: o.buyer_email || undefined });
}

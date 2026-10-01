// Inventory stickers: one small label per unsold item - a short code, the name, the price and a
// QR that opens the item in the app. Stick it on the item (or its bag) when it goes on the shelf;
// when it sells, scan it and the item, its order and its label are right there.
// Laid out for Avery 5160 / 8160 (30 per letter sheet, 2-5/8" x 1"), or plain paper with cut lines.

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const itemCode = id => "G-" + String(id || "").replace(/-/g, "").slice(0, 6).toUpperCase();

export async function stickerItems(db, userId, ids = null) {
  const rows = (await db.prepare(
    `SELECT i.id, COALESCE(i.ai_title, i.name) AS title, i.price_cents,
            (SELECT result_json FROM appraisals a WHERE a.item_id=i.id AND a.status='done' ORDER BY a.created_at DESC LIMIT 1) AS rj
       FROM items i JOIN sales s ON s.id=i.sale_id
      WHERE s.user_id=? AND i.listing_status<>'sold' ORDER BY i.created_at DESC LIMIT 300`).bind(userId).all()).results;
  const want = ids && ids.length ? new Set(ids) : null;
  return rows.filter(r => !want || want.has(r.id)).map(r => {
    let est = null; try { est = JSON.parse(r.rj || "null")?.price_range?.suggested_retail ?? null; } catch {}
    const cents = r.price_cents || (Number(est) > 0 ? Math.round(est * 100) : null);
    return { id: r.id, code: itemCode(r.id), title: r.title || "Item", price_cents: cents };
  });
}

export function stickerPage(items, origin, { skip = 0, plain = false } = {}) {
  const money = c => c ? "$" + (c / 100).toFixed(c % 100 ? 2 : 0) : "";
  const blanks = Array.from({ length: Math.max(0, Math.min(29, skip | 0)) }, () => `<div class="lb blank"></div>`).join("");
  const labels = items.map(it => `<div class="lb"><div class="q" data-u="${esc(`${origin}/#item-${it.id}`)}"></div>
<div class="tx"><div class="cd">${esc(it.code)}</div><div class="tt">${esc(it.title.slice(0, 60))}</div>${it.price_cents ? `<div class="pr">${money(it.price_cents)}</div>` : ""}</div></div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Item stickers</title><script src="/vendor/qrcode.js"></script>
<style>@page{size:letter;margin:0}body{font-family:system-ui,sans-serif;margin:0}
.bar{padding:12px;background:#0f6b59;color:#fff;font-size:14px;line-height:1.5}.bar button,.bar select,.bar a{font:600 14px system-ui;padding:6px 10px;border-radius:8px;border:0;margin:2px}.bar a{background:#fff;color:#0f6b59;text-decoration:none}
.sheet{width:8.5in;padding:.5in .1875in 0;box-sizing:border-box;display:grid;grid-template-columns:repeat(3,2.625in);column-gap:.125in;grid-auto-rows:1in}
.lb{box-sizing:border-box;height:1in;padding:.06in .1in;display:flex;gap:.08in;align-items:center;overflow:hidden;${plain ? "border:1px dashed #999;" : ""}}
.q svg{width:.8in;height:.8in;display:block}.tx{min-width:0}.cd{font:800 13px ui-monospace,Consolas,monospace;letter-spacing:.5px}
.tt{font-size:8.5px;line-height:1.2;max-height:2.4em;overflow:hidden;margin-top:1px}.pr{font:800 13px Georgia,serif;margin-top:2px}
@media print{.bar{display:none}}</style></head>
<body><div class="bar"><b>${items.length} item sticker${items.length === 1 ? "" : "s"}</b> · Avery 5160 / 8160 sheets (30 per page)${plain ? ", or plain paper: cut on the lines" : ""}. Print at <b>Actual size / 100%</b>, margins <b>None</b>.<br>
Part-used sheet? Start at label <select onchange="var u=new URL(location);u.searchParams.set('skip',this.value-1);location=u">${Array.from({ length: 30 }, (_, i) => `<option${i === skip ? " selected" : ""}>${i + 1}</option>`).join("")}</select>
<a href="?${plain ? "" : "plain=1&"}skip=${skip}">${plain ? "Sticker sheet" : "Plain paper"}</a> <button onclick="print()">Print</button></div>
<div class="sheet">${blanks}${labels}</div>
<script>document.querySelectorAll('.q').forEach(function(el){var q=qrcode(0,'M');q.addData(el.dataset.u);q.make();el.innerHTML=q.createSvgTag({cellSize:2,margin:0});});</script></body></html>`;
}
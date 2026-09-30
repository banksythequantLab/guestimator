// eBay sales of things listed through Guestimator: what sold, where it goes, packing slip, and
// "mark shipped" (tracking goes to eBay for you).
// globals: $, app, api, esc, money, toast, setChrome, renderHome, state, ctx, backTo, connectEbay.

const EBAY_OPEN = new Set(["NOT_STARTED", "IN_PROGRESS"]);
const shipToText = json => { try { const a = JSON.parse(json || "null"); const d = a && a.address; if (!d) return "";
  return [a.name, [d.line1, d.line2].filter(Boolean).join(" "), [d.city, [d.state, d.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(" · "); } catch { return ""; } };
const guessCarrier = t => { const n = String(t || "").replace(/\s+/g, "").toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(n)) return "UPS"; if (/^(94|93|92|95|82)\d{18,22}$/.test(n) || /^[A-Z]{2}\d{9}US$/.test(n)) return "USPS";
  if (/^\d{12}$|^\d{15}$/.test(n)) return "FedEx"; return ""; };

// Home-screen count of eBay orders waiting to ship; also triggers a fresh read from eBay.
async function ebayOrdersBadge(el) {
  try {
    const d = await api("/ebay/orders");
    const n = (d.orders || []).filter(o => EBAY_OPEN.has(o.status)).length;
    if (el && (n || d.needs_reconnect)) {
      el.textContent = d.needs_reconnect ? "!" : n;
      el.title = d.needs_reconnect ? "Reconnect eBay to get sale alerts" : `${n} to ship`;
      el.style.cssText = "display:inline-block;min-width:20px;padding:0 6px;margin-left:4px;border-radius:10px;background:var(--rust);color:#fff;font-size:.75rem;line-height:20px;text-align:center";
    }
  } catch {}
}

async function renderEbayOrders() {
  state.view = "ebayOrders"; setChrome(); backTo(renderHome);
  ctx.textContent = "eBay sales";
  if (location.hash === "#ebay-orders") history.replaceState(null, "", "/");
  app.innerHTML = `<div class="muted" style="padding:14px">Checking eBay…</div>`;
  let d;
  try { d = await api("/ebay/orders"); } catch (e) { app.innerHTML = `<div class="muted" style="padding:14px">${esc(e.message)}</div>`; return; }
  const open = d.orders.filter(o => EBAY_OPEN.has(o.status)), done = d.orders.filter(o => !EBAY_OPEN.has(o.status));
  const card = o => `<div class="li" style="align-items:flex-start">
      ${o.thumb ? `<img src="${esc(o.thumb)}" alt="" style="width:52px;height:52px;object-fit:cover;border-radius:8px">` : `<span style="width:52px;text-align:center">📦</span>`}
      <div style="min-width:0;flex:1"><div class="nm">${esc(o.item_title)}${o.quantity > 1 ? ` × ${o.quantity}` : ""}${o.total_cents != null ? ` · ${money(o.total_cents)}` : ""}</div>
        <div class="muted" style="font-size:.8rem">eBay order ${esc(o.order_id)}${o.buyer ? ` · ${esc(o.buyer)}` : ""} · ${esc(String(o.ordered_at).slice(0, 10))}</div>
        ${EBAY_OPEN.has(o.status) ? `
          ${o.ship_to ? `<div class="muted" style="font-size:.8rem">Ship to: ${esc(shipToText(o.ship_to))}</div>` : ""}
          ${o.ship_by ? `<div style="font-size:.8rem;color:var(--rust)">Ship by ${esc(String(o.ship_by).slice(0, 10))}</div>` : ""}
          <div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap">
            <input data-trk="${esc(o.id)}" placeholder="Tracking #" style="flex:1;min-width:140px">
            <select data-car="${esc(o.id)}" style="width:auto"><option value="">Carrier</option><option>USPS</option><option>UPS</option><option>FedEx</option></select>
            <button class="btn sm" data-ship="${esc(o.id)}">Mark shipped</button></div>
          <a class="btn sec sm" href="/api/ebay/orders/${encodeURIComponent(o.id)}/slip" target="_blank" rel="noopener" style="text-decoration:none;margin-top:6px;display:inline-block">🖨 Packing slip</a>`
        : `<div style="margin-top:4px"><span class="pill">${o.status === "CANCELLED" ? "cancelled" : "shipped"}</span>${o.tracking ? ` <span class="muted" style="font-size:.8rem">${esc(o.tracking)}</span>` : ""}</div>`}
      </div></div>`;
  app.innerHTML = `
    ${d.needs_reconnect ? `<div class="card" style="border-color:var(--rust)"><b>Reconnect eBay to get sale alerts</b>
      <div class="muted" style="font-size:.85rem;margin:4px 0 8px">Your eBay connection is from before Guestimator could see orders. Connect once more and approve the new permission; your listings stay as they are.</div>
      <button class="btn" id="reEbay" style="background:var(--cobalt)">Reconnect eBay</button></div>` : ""}
    ${d.error ? `<div class="card muted" style="font-size:.85rem">eBay didn't answer just now: ${esc(d.error)}</div>` : ""}
    <h3 style="margin:14px 2px 6px">To ship (${open.length})</h3>
    <div class="list">${open.map(card).join("") || `<div class="empty"><div class="em">📭</div>Nothing waiting. When something you listed sells, it shows up here and you get an email.</div>`}</div>
    ${done.length ? `<h3 style="margin:14px 2px 6px">Last 30 days</h3><div class="list">${done.map(card).join("")}</div>` : ""}`;
  if ($("#reEbay")) $("#reEbay").onclick = () => connectEbay();
  app.querySelectorAll("[data-trk]").forEach(inp => inp.oninput = () => {
    const sel = app.querySelector(`[data-car="${CSS.escape(inp.dataset.trk)}"]`), g = guessCarrier(inp.value);
    if (g && sel) sel.value = g;
  });
  app.querySelectorAll("[data-ship]").forEach(b => b.onclick = async () => {
    const id = b.dataset.ship;
    const tracking = app.querySelector(`[data-trk="${CSS.escape(id)}"]`).value.trim();
    const carrier = app.querySelector(`[data-car="${CSS.escape(id)}"]`).value;
    if (!tracking && !confirm("Mark shipped without a tracking number? Buyers and eBay both prefer one.")) return;
    b.disabled = true;
    try { await api(`/ebay/orders/${encodeURIComponent(id)}/ship`, { method: "POST", body: JSON.stringify({ tracking, carrier }) }); toast("Marked shipped on eBay ✓"); renderEbayOrders(); }
    catch (e) { toast(e.message); b.disabled = false; }
  });
}

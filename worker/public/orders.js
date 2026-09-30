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
          <a class="btn sec sm" href="/api/ebay/orders/${encodeURIComponent(o.id)}/slip" target="_blank" rel="noopener" style="text-decoration:none;margin-top:6px;display:inline-block">🖨 Packing slip</a>
          ${labelBtnHtml("ebay", o.id)}`
        : `<div style="margin-top:4px"><span class="pill">${o.status === "CANCELLED" ? "cancelled" : "shipped"}</span>${o.tracking ? ` <span class="muted" style="font-size:.8rem">${esc(o.tracking)}</span>` : ""}</div>`}
      </div></div>`;
  app.innerHTML = `
    ${d.needs_reconnect ? `<div class="card" style="border-color:var(--rust)"><b>Reconnect eBay to get sale alerts</b>
      <div class="muted" style="font-size:.85rem;margin:4px 0 8px">Your eBay connection is from before Guestimator could see orders. Connect once more and approve the new permission; your listings stay as they are.</div>
      <button class="btn" id="reEbay" style="background:var(--cobalt)">Reconnect eBay</button></div>` : ""}
    ${d.error ? `<div class="card muted" style="font-size:.85rem">eBay didn't answer just now: ${esc(d.error)}</div>` : ""}
    <h3 style="margin:14px 2px 6px">To ship (${open.length})</h3>
    <div class="list">${open.map(card).join("") || `<div class="empty"><div class="em">📭</div>Nothing waiting. When something you listed sells, it shows up here and you get an email.</div>`}</div>
    ${done.length ? `<h3 style="margin:14px 2px 6px">Last 30 days</h3><div class="list">${done.map(card).join("")}</div>` : ""}
    <div id="slowBox"></div>`;
  slowSellers($("#slowBox"));
  if ($("#reEbay")) $("#reEbay").onclick = () => connectEbay();
  wireLabels(app, renderEbayOrders);
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

// ---------- shipping labels (garage-sale and eBay orders) ----------
// Shown only when buying labels is switched on for this account. Flow: return address (once) ->
// real rates to the buyer for the box (editable: weigh it) -> pick one -> buy -> print. Buying
// marks the order shipped with the label's tracking number.
let labelCfg = null;
async function labelSettings() {
  if (labelCfg) return labelCfg;
  try { labelCfg = await api("/labels/settings"); } catch { labelCfg = { enabled: false }; }
  return labelCfg;
}
const labelBtnHtml = (kind, id) => `<button class="btn sec sm" data-label-kind="${kind}" data-label-id="${esc(id)}" style="margin-top:6px">🏷️ Buy shipping label</button><div data-label-box="${esc(id)}"></div>`;

// Wire every label button on the screen; `after` redraws the screen once a label is bought.
async function wireLabels(root, after) {
  const btns = root.querySelectorAll("[data-label-kind]");
  if (!btns.length) return;
  const cfg = await labelSettings();
  btns.forEach(async b => {
    if (!cfg.enabled) { b.remove(); return; }
    const kind = b.dataset.labelKind, id = b.dataset.labelId;
    const box = root.querySelector(`[data-label-box="${CSS.escape(id)}"]`);
    try {   // already bought? offer the print link instead
      const { label } = await api(`/labels/for?kind=${kind}&order=${encodeURIComponent(id)}`);
      if (label) { b.remove(); box.innerHTML = labelDone(label); return; }
    } catch {}
    b.onclick = () => { b.remove(); labelPanel(kind, id, box, after); };
  });
}
const labelDone = l => `<div style="margin-top:6px;font-size:.82rem"><a class="btn sm" href="${esc(l.label_url)}" target="_blank" rel="noopener" style="text-decoration:none">🖨 Print label</a>
  <span class="muted">${esc(l.service || l.carrier || "")} · ${money(l.amount_cents)}${l.tracking ? ` · ${esc(l.tracking)}` : ""}</span></div>`;

function fromForm(f) {
  f = f || {};
  const i = (k, ph, w = 1, extra = "") => `<div style="flex:${w}"><input data-from="${k}" value="${esc(f[k] || "")}" placeholder="${ph}" ${extra}></div>`;
  return `<div class="card" style="margin:8px 0;padding:10px"><b style="font-size:.9rem">Your return address</b>
    <div class="muted" style="font-size:.78rem;margin-bottom:6px">Printed on the label as the sender. Saved for next time.</div>
    <div class="row" style="gap:6px">${i("name", "Your name")}${i("phone", "Phone (optional)", 1, 'type="tel"')}</div>
    <div class="row" style="gap:6px;margin-top:6px">${i("street1", "Street", 2)}${i("street2", "Apt (optional)")}</div>
    <div class="row" style="gap:6px;margin-top:6px">${i("city", "City", 2)}${i("state", "NJ", .6, 'maxlength="2" style="text-transform:uppercase"')}${i("zip", "ZIP", 1, 'inputmode="numeric" maxlength="5"')}</div>
    <button class="btn sm" data-from-save style="margin-top:8px">Save address</button></div>`;
}

async function labelPanel(kind, id, box, after, over) {
  const cfg = await labelSettings();
  if (!cfg.ship_from) {
    box.innerHTML = fromForm(null);
    box.querySelector("[data-from-save]").onclick = async ev => {
      const body = {}; box.querySelectorAll("[data-from]").forEach(x => body[x.dataset.from] = x.value);
      ev.target.disabled = true;
      try { const r = await api("/labels/settings", { method: "PUT", body: JSON.stringify(body) }); labelCfg.ship_from = r.ship_from; labelPanel(kind, id, box, after, over); }
      catch (e) { toast(e.message); ev.target.disabled = false; }
    };
    return;
  }
  box.innerHTML = `<div class="muted" style="font-size:.82rem;margin-top:6px">Getting rates to the buyer…</div>`;
  let q;
  try { q = await api("/labels/rates", { method: "POST", body: JSON.stringify({ kind, order_id: id, ...(over || {}) }) }); }
  catch (e) {
    if (e.needs_parcel || /box size/i.test(e.message)) { box.innerHTML = parcelInputs(null); wireParcel(); return; }
    box.innerHTML = `<div style="color:var(--rust);font-size:.82rem;margin-top:6px">${esc(e.message)}</div>`; return;
  }
  const p = q.parcel;
  box.innerHTML = `<div class="card" style="margin:8px 0;padding:10px">
    ${parcelInputs(p)}
    ${q.rates.length ? `<div style="margin-top:8px">${q.rates.map((r, n) => `<label class="row" style="gap:8px;font-weight:400;font-size:.88rem;margin:4px 0">
        <input type="radio" name="rate-${esc(id)}" value="${esc(r.rate_id)}" data-cents="${Math.round(r.amount * 100)}" ${n === 0 ? "checked" : ""} style="width:auto">
        <span style="flex:1">${esc(r.service)}${r.days ? ` <span class="muted">· ${r.days} day${r.days === 1 ? "" : "s"}</span>` : ""}</span><b>$${r.amount.toFixed(2)}</b></label>`).join("")}</div>
      <div class="row" style="gap:6px;margin-top:6px;align-items:center"><select data-paper style="width:auto"><option value="PDF">Letter paper</option><option value="PDF_4x6">4×6 label printer</option></select>
        <button class="btn sm" data-buy style="flex:1">Buy label</button></div>
      <div class="muted" style="font-size:.72rem;margin-top:4px">Charged to the Shippo account on file. Buying marks the order shipped and sends the tracking number${kind === "ebay" ? " to eBay" : " to the buyer"}.</div>`
    : `<div class="muted" style="font-size:.82rem;margin-top:6px">${esc(q.note || "No rates.")}</div>`}</div>`;
  wireParcel();
  const buy = box.querySelector("[data-buy]");
  if (buy) {
    const sel = () => box.querySelector(`input[name="rate-${CSS.escape(id)}"]:checked`);
    const label = () => { const s = sel(); buy.textContent = s ? `Buy label · $${(s.dataset.cents / 100).toFixed(2)}` : "Buy label"; };
    box.querySelectorAll(`input[name="rate-${CSS.escape(id)}"]`).forEach(x => x.onchange = label); label();
    buy.onclick = async () => {
      const s = sel(); if (!s) return;
      if (!confirm(`Buy this label for $${(s.dataset.cents / 100).toFixed(2)}? It's charged right away.`)) return;
      buy.disabled = true; buy.textContent = "Buying…";
      try {
        const r = await api("/labels/buy", { method: "POST", body: JSON.stringify({ kind, order_id: id, rate_id: s.value, amount_cents: Number(s.dataset.cents), file_type: box.querySelector("[data-paper]").value }) });
        box.innerHTML = labelDone(r.label) + (r.shipped ? "" : `<div style="color:var(--rust);font-size:.8rem">Label bought, but not marked shipped: ${esc(r.shipped_error || "")}. Mark it shipped with the tracking number above.</div>`);
        window.open(r.label.label_url, "_blank", "noopener");
        toast("Label bought ✓"); if (after) setTimeout(after, 1500);
      } catch (e) { toast(e.message); buy.disabled = false; label(); }
    };
  }
  function wireParcel() {
    const re = box.querySelector("[data-reprice]");
    if (re) re.onclick = () => {
      const v = k => Number(box.querySelector(`[data-p="${k}"]`).value);
      labelPanel(kind, id, box, after, { box_in: [v("l"), v("w"), v("h")], weight_lb: v("lb") });
    };
  }
}
function parcelInputs(p) {
  const v = (x, d) => esc(p ? String(x) : d);
  const n = (k, val, ph) => `<input data-p="${k}" value="${val}" placeholder="${ph}" inputmode="decimal" style="width:56px">`;
  return `<div class="row" style="gap:4px;align-items:center;flex-wrap:wrap;font-size:.82rem">Box ${n("l", v(p && p.length, ""), "L")}×${n("w", v(p && p.width, ""), "W")}×${n("h", v(p && p.height, ""), "H")} in,
    ${n("lb", v(p && p.weight, ""), "lb")} lb <button class="btn sec sm" data-reprice>${p ? "Re-price" : "Get rates"}</button></div>
    ${p ? `<div class="muted" style="font-size:.72rem">Our estimate. Weigh and measure the packed box and re-price if it's different: the carrier charges extra if it's off.</div>` : ""}`;
}

// ---------- slow sellers: eBay listings unsold for two weeks, with a suggested lower price ----------
async function slowSellers(box) {
  if (!box) return;
  let d; try { d = await api("/ebay/slow"); } catch { return; }
  if (!d.listings.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<h3 style="margin:14px 2px 6px">Not selling yet (${d.listings.length})</h3>
    <div class="muted" style="font-size:.8rem;margin:0 2px 6px">Listed two weeks or more without a sale. A small drop often does it; suggestions never go below the low end of your estimate.</div>
    <div class="list">${d.listings.map(l => `<div class="li" style="align-items:flex-start" data-slow-row="${esc(l.id)}">
      <div style="min-width:0;flex:1"><div class="nm"><a href="${esc(l.listing_url || "#")}" target="_blank" rel="noopener" style="color:inherit">${esc(l.title)}</a></div>
        <div class="muted" style="font-size:.8rem">${money(l.price_cents)} for ${l.days} days${l.low_cents ? ` · estimate low ${money(l.low_cents)}` : ""}</div>
        <div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center">
          <input data-slow-price="${esc(l.id)}" value="${(l.suggested_cents / 100).toFixed(2)}" inputmode="decimal" style="width:90px">
          <button class="btn sm" data-slow-lower="${esc(l.id)}">Lower on eBay</button>
          <button class="btn sec sm" data-slow-keep="${esc(l.id)}">Keep price</button></div></div></div>`).join("")}</div>`;
  box.querySelectorAll("[data-slow-lower]").forEach(b => b.onclick = async () => {
    const id = b.dataset.slowLower, v = Number(box.querySelector(`[data-slow-price="${CSS.escape(id)}"]`).value);
    if (!(v > 0)) return toast("Enter a price");
    if (!confirm(`Change the eBay price to $${v.toFixed(2)}?`)) return;
    b.disabled = true;
    try { await api(`/ebay/slow/${encodeURIComponent(id)}/lower`, { method: "POST", body: JSON.stringify({ price_cents: Math.round(v * 100) }) }); toast("Price lowered on eBay ✓"); slowSellers(box); }
    catch (e) { toast(e.message); b.disabled = false; }
  });
  box.querySelectorAll("[data-slow-keep]").forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { await api(`/ebay/slow/${encodeURIComponent(b.dataset.slowKeep)}/keep`, { method: "POST" }); slowSellers(box); } catch (e) { toast(e.message); b.disabled = false; }
  });
}

// ---------- profit & inventory report ----------
async function renderProfit(range) {
  state.view = "profit"; setChrome(); backTo(renderHome);
  ctx.textContent = "Profit";
  const y = new Date().getFullYear(), mo = new Date().toISOString().slice(0, 7);
  const RANGES = { month: [mo + "-01", ""], year: [y + "-01-01", ""], last: [(y - 1) + "-01-01", (y - 1) + "-12-31"], all: ["", ""] };
  range = range || "year";
  const [from, to] = RANGES[range];
  const qs = `from=${from}&to=${to}`;
  app.innerHTML = `<div class="muted" style="padding:14px">Adding it up…</div>`;
  let d; try { d = await api(`/profit?${qs}`); } catch (e) { app.innerHTML = `<div class="muted" style="padding:14px">${esc(e.message)}</div>`; return; }
  const t = d.totals, inv = d.inventory;
  const m = c => (c == null ? "—" : money(c));
  const tile = (k, v, sub) => `<div style="flex:1;min-width:120px;padding:8px 10px;border:1px solid var(--line);border-radius:10px"><div class="muted" style="font-size:.72rem">${k}</div><div style="font:700 1.2rem Georgia,serif">${v}</div>${sub ? `<div class="muted" style="font-size:.7rem">${sub}</div>` : ""}</div>`;
  app.innerHTML = `
    <div class="card">
      <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:10px">${[["month", "This month"], ["year", "This year"], ["last", "Last year"], ["all", "All time"]]
        .map(([k, l]) => `<button class="btn ${k === range ? "" : "sec "}sm" data-range="${k}">${l}</button>`).join("")}</div>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        ${tile("Profit", m(t.profit_cents), `${t.sales} sale${t.sales === 1 ? "" : "s"}`)}
        ${tile("Sales", m(t.sale_cents), t.ship_paid_cents ? `+ ${m(t.ship_paid_cents)} shipping paid` : "")}
        ${tile("Fees + labels", m(t.fee_cents + t.label_cents), "")}
        ${tile("Your cost", m(t.cost_cents), t.missing_cost ? `${t.missing_cost} without a cost` : "")}
      </div>
      ${t.missing_cost ? `<div class="muted" style="font-size:.75rem;margin-top:6px">Profit counts items with no cost as free. Add "What you paid" on those items to make it exact.</div>` : ""}
      <a class="btn sec sm" href="/api/profit/csv?${qs}" style="text-decoration:none;margin-top:10px;display:inline-block">⬇ Download CSV</a>
    </div>
    <div class="card"><b>Still on the shelf</b>
      <div class="muted" style="font-size:.85rem;margin-top:4px">${inv.items} item${inv.items === 1 ? "" : "s"} not sold · ${inv.priced} priced at about <b>${money(inv.estimate_cents)}</b> in all${inv.cost_cents ? ` · cost you ${money(inv.cost_cents)}` : ""}</div></div>
    <h3 style="margin:14px 2px 6px">Sales</h3>
    <div class="list">${d.rows.map(r => `<div class="li tap" data-item="${esc(r.item_id)}" style="align-items:flex-start">
      <div style="min-width:0;flex:1"><div class="nm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.title || "Item")}</div>
        <div class="muted" style="font-size:.78rem">${esc(String(r.at).slice(0, 10))} · ${esc(r.channel)} · sold ${m(r.sale_cents)}${r.ship_paid_cents ? ` + ${m(r.ship_paid_cents)} ship` : ""} · fees ${m(r.fee_cents)}${r.label_cents ? ` · label ${m(r.label_cents)}` : ""} · cost ${r.missing_cost ? "not entered" : m(r.cost_cents)}</div></div>
      <span class="pr" style="${r.profit_cents != null && r.profit_cents < 0 ? "color:var(--rust)" : ""}">${m(r.profit_cents)}</span></div>`).join("")
      || `<div class="empty"><div class="em">🧾</div>No sales in this period yet.</div>`}</div>`;
  app.querySelectorAll("[data-range]").forEach(b => b.onclick = () => renderProfit(b.dataset.range));
  app.querySelectorAll("[data-item]").forEach(li => li.onclick = () => renderItemDetail(li.dataset.item));
}

// ---------- bulk mode: many items in one go ----------
// One photo per item, taken back to back (or picked from the camera roll all at once), a few
// words each, then all created together and optionally all priced. Finding items inside a single
// room photo was tried first (Sep 30 2026): none of the vision models on Token Factory put boxes
// in the right place reliably, so crops cut items in half. One photo per item always works.
async function renderBulk() {
  state.view = "bulk"; setChrome(); backTo(renderHome);
  ctx.textContent = "Lots of items";
  const picked = [];   // { file, url }
  const draw = () => {
    $("#bList").innerHTML = picked.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">${picked.map((p, n) => `
      <div style="border:1px solid var(--line);border-radius:10px;padding:6px">
        <img src="${p.url}" alt="" style="width:100%;height:120px;object-fit:cover;border-radius:6px">
        <input data-bname="${n}" value="${esc(p.name || "")}" placeholder="What is it? e.g. brass lamp" style="font-size:.85rem;margin-top:4px">
        <a href="#" data-bdel="${n}" class="muted" style="font-size:.75rem">remove</a></div>`).join("")}</div>
      <button class="btn" id="bAdd" style="margin-top:12px">Add ${picked.length} item${picked.length === 1 ? "" : "s"}</button>` : "";
    app.querySelectorAll("[data-bname]").forEach(i => i.oninput = () => { picked[Number(i.dataset.bname)].name = i.value; });
    app.querySelectorAll("[data-bdel]").forEach(a => a.onclick = e => { e.preventDefault(); picked.splice(Number(a.dataset.bdel), 1); draw(); });
    if ($("#bAdd")) $("#bAdd").onclick = addAll;
  };
  app.innerHTML = `<div class="card" style="border-color:var(--green)">
      <h1 class="h1" style="margin:0 0 4px">Lots of items at once</h1>
      <div class="muted" style="font-size:.9rem;margin-bottom:12px">Clearing out a shelf, a room or a whole house? Take one photo of each thing, back to back, or pick them all from your camera roll. Give each a few words, then add them all together. Adding is free; each estimate is 1 credit.</div>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <label class="btn" style="flex:1;text-align:center">📷 Take a photo<input type="file" id="bCam" accept="image/*" capture="environment" style="display:none"></label>
        <label class="btn sec" style="flex:1;text-align:center">🖼 Pick several<input type="file" id="bRoll" accept="image/*" multiple style="display:none"></label></div>
    </div><div id="bList"></div>`;
  const take = files => { for (const f of files) if (picked.length < 50) picked.push({ file: f, url: URL.createObjectURL(f), name: "" }); draw(); if (picked.length >= 50) toast("50 at a time — add these, then do the next batch"); };
  $("#bCam").onchange = e => { take([...e.target.files]); e.target.value = ""; };
  $("#bRoll").onchange = e => { take([...e.target.files]); e.target.value = ""; };

  async function addAll() {
    const missing = picked.findIndex(p => !String(p.name || "").trim());
    if (missing !== -1) { const i = app.querySelector(`[data-bname="${missing}"]`); i.focus(); i.style.borderColor = "var(--rust)"; return toast("Give each one a few words — the photo alone gets it wrong too often."); }
    const btn = $("#bAdd"); btn.disabled = true;
    const made = [];
    for (const p of picked) {
      btn.textContent = `Adding ${made.length + 1} of ${picked.length}…`;
      const name = p.name.trim().slice(0, 120);
      try {
        const { id } = await api("/items", { method: "POST", body: JSON.stringify({ name, description: name }) });
        const fd = new FormData(); fd.append("photos", await shrink(p.file), "front.jpg"); fd.append("kinds", "front");
        const up = await fetch(`/api/items/${id}/photos`, { method: "POST", body: fd, credentials: "same-origin" });
        if (!up.ok) throw new Error("photo upload failed");
        made.push(id);
      } catch (e) { toast(`${name}: ${e.message}`); }
    }
    $("#bList").innerHTML = `<div class="card" style="border-color:var(--green)"><b>Added ${made.length} item${made.length === 1 ? "" : "s"}</b>
      <div class="muted" style="font-size:.85rem;margin:4px 0 10px">Price them all now, or open each one to add a close-up of its marks first (better estimates).</div>
      <button class="btn" id="bPrice">✨ Guestimate all ${made.length} (${made.length} credit${made.length === 1 ? "" : "s"})</button>
      <button class="btn sec" id="bLater" style="margin-top:8px">Later — show my items</button></div>`;
    $("#bLater").onclick = renderHome;
    $("#bPrice").onclick = async () => {
      if (!confirm(`Use ${made.length} credit${made.length === 1 ? "" : "s"} to price all ${made.length}?`)) return;
      const b2 = $("#bPrice"); b2.disabled = true; let done = 0;
      for (const id of made) {
        b2.textContent = `Starting ${done + 1} of ${made.length}…`;
        try { await api(`/items/${id}/appraise`, { method: "POST", body: JSON.stringify({}) }); done++; }
        catch (e) { toast(e.message); break; }   // out of credits: the paywall has opened; stop here
      }
      toast(`${done} estimate${done === 1 ? "" : "s"} running — they show on your items as they finish`);
      renderHome();
    };
  }
}

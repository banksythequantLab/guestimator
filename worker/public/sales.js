// Guestimator — garage, yard and estate sales (seller screens). Loaded after app.js and uses its
// globals: $, app, api, esc, money, toast, setChrome, renderHome, renderItemDetail, state, isNative.
const SALE_KINDS = { garage: "Garage sale", yard: "Yard sale", estate: "Estate sale", moving: "Moving sale" };
const dollars = c => (c == null ? "" : (c / 100).toFixed(2).replace(/\.00$/, ""));
const dayFmt = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const saleWhen = s => (s.starts_on === s.ends_on ? dayFmt(s.starts_on) : `${dayFmt(s.starts_on)} – ${dayFmt(s.ends_on)}`) + (s.hours ? ` · ${s.hours}` : "");
const PHASE = { upcoming: "coming up", open: "on now", ended: "ended" };
let stripeStatus = null;

function backTo(fn) {
  backBtn.classList.remove("hidden");
  backBtn.onclick = () => fn();
}

async function loadStripeStatus() {
  try { stripeStatus = await api("/garage/stripe/status"); } catch (e) { stripeStatus = { off: true, error: e.message }; }
  return stripeStatus;
}
function stripeCardHtml(s) {
  if (!s || s.off) return `<div class="card"><b>Sell online</b><div class="muted" style="font-size:.85rem;margin-top:4px">Online payments aren't switched on yet. Shoppers can still browse and ask you to hold things.</div></div>`;
  if (s.ready) return `<div class="card" style="border-color:var(--green)"><b>Online payments are on ✓</b>
    <div class="muted" style="font-size:.85rem;margin:4px 0 8px">Buyers pay you by card through your own Stripe account. Refunds and disputes are handled in your Stripe dashboard. Guestimator keeps a small fee on online sales only.</div>
    <button class="btn sec sm" id="stripeDash">Open my Stripe dashboard</button></div>`;
  return `<div class="card" style="border-color:var(--cobalt)"><b>Let people buy online</b>
    <div class="muted" style="font-size:.85rem;margin:4px 0 8px">Connect a free Stripe account in your name (about 10 minutes: name, address, bank account, SSN for tax reporting). Buyers pay you by card for pickup or shipping, your name is on their receipt, and Stripe pays you out. Guestimator keeps a small fee on online sales only; in-person sales are free.</div>
    <button class="btn" id="stripeGo" style="background:var(--cobalt)">${s.connected ? "Finish Stripe setup" : "Connect Stripe"}</button></div>`;
}
function wireStripeCard(after) {
  const go = $("#stripeGo"), dash = $("#stripeDash");
  const open = async (path, btn) => {
    btn.disabled = true;
    try {
      const { url } = await api(path, { method: "POST" });
      if (isNative && window.Capacitor?.Plugins?.Browser) await Capacitor.Plugins.Browser.open({ url });
      else location.href = url;
    } catch (e) { toast(e.message); btn.disabled = false; }
  };
  if (go) go.onclick = () => open("/garage/stripe/connect", go);
  if (dash) dash.onclick = () => open("/garage/stripe/dashboard", dash);
}

// ---------- list of sales ----------
async function renderSales() {
  state.view = "sales"; setChrome(); backTo(renderHome);
  ctx.textContent = "Your sales";
  app.innerHTML = `
    <div class="card" style="border-color:var(--green)">
      <h1 class="h1" style="margin:0 0 4px">Garage & estate sales</h1>
      <div class="muted" style="font-size:.9rem;margin-bottom:12px">Free. Put your priced items on a public page, share the link, print price tags with QR codes, and take holds. The street address stays hidden until the sale starts.</div>
      <button class="btn" id="newSale">＋ Start a sale</button>
    </div>
    <div id="stripeCard"></div>
    <div id="saleList" class="list"><div class="muted" style="padding:10px">Loading…</div></div>`;
  $("#newSale").onclick = () => renderSaleForm(null);
  loadStripeStatus().then(s => { const c = $("#stripeCard"); if (c && state.view === "sales") { c.innerHTML = stripeCardHtml(s); wireStripeCard(renderSales); } });
  let list = [];
  try { list = await api("/garage/sales"); } catch (e) { $("#saleList").innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }
  const el = $("#saleList");
  if (!list.length) { el.innerHTML = `<div class="empty"><div class="em">🏷️</div>No sales yet. Start one, then add items you've guestimated.</div>`; return; }
  el.innerHTML = list.map(s => `<div class="li tap" data-sale="${s.id}">
      <span style="width:40px;text-align:center;font-size:1.4rem">${s.kind === "estate" ? "🏛️" : "🏷️"}</span>
      <div style="min-width:0"><div class="nm">${esc(s.title)}</div>
        <div class="muted" style="font-size:.8rem">${esc(saleWhen(s))} · ${esc(s.city)}, ${esc(s.state)}</div>
        <div style="margin-top:3px"><span class="pill">${s.status === "draft" ? "draft" : PHASE[s.phase] || s.status}</span> <span class="pill">${s.items} items</span>
        ${s.new_holds ? `<span class="pill" style="background:#fde7c7">${s.new_holds} hold request${s.new_holds > 1 ? "s" : ""}</span>` : ""}
        ${s.open_orders ? `<span class="pill" style="background:var(--cobalt);color:#fff">${s.open_orders} to send</span>` : ""}</div></div>
    </div>`).join("");
  el.querySelectorAll("[data-sale]").forEach(li => li.onclick = () => renderSale(li.dataset.sale));
}

// ---------- create / edit ----------
function renderSaleForm(sale, then) {
  state.view = "saleForm"; setChrome(); backTo(sale ? () => renderSale(sale.id) : renderSales);
  ctx.textContent = sale ? "Edit sale" : "New sale";
  const s = sale || { kind: "garage", pickup_ok: 1, ship_ok: 0, online_ok: 0 };
  const today = new Date().toISOString().slice(0, 10);
  app.innerHTML = `<div class="card">
    <label>Kind of sale</label><select id="sKind">${Object.entries(SALE_KINDS).map(([k, v]) => `<option value="${k}" ${s.kind === k ? "selected" : ""}>${v}</option>`).join("")}</select>
    <label>Title</label><input id="sTitle" maxlength="90" value="${esc(s.title || "")}" placeholder="e.g. Whole-house estate sale, furniture & tools">
    <div class="row" style="gap:8px"><div style="flex:1"><label>First day</label><input id="sStart" type="date" value="${esc(s.starts_on || today)}"></div>
      <div style="flex:1"><label>Last day</label><input id="sEnd" type="date" value="${esc(s.ends_on || s.starts_on || today)}"></div></div>
    <label>Hours</label><input id="sHours" maxlength="80" value="${esc(s.hours || "")}" placeholder="8am – 2pm">
    <label>Street address</label><input id="sStreet" maxlength="120" value="${esc(s.street || "")}" placeholder="Hidden until the first day of the sale">
    <div class="row" style="gap:8px"><div style="flex:2"><label>City</label><input id="sCity" maxlength="60" value="${esc(s.city || "")}"></div>
      <div style="flex:1"><label>State</label><input id="sState" maxlength="2" value="${esc(s.state || "")}" placeholder="NJ" style="text-transform:uppercase"></div>
      <div style="flex:1.3"><label>ZIP</label><input id="sZip" maxlength="10" inputmode="numeric" value="${esc(s.zip || "")}"></div></div>
    <label>About the sale (optional)</label><textarea id="sDesc" rows="3" maxlength="2000" placeholder="Parking, cash/card, what's inside…">${esc(s.description || "")}</textarea>
    <label>Phone for accepted holds (optional)</label><input id="sPhone" type="tel" maxlength="30" value="${esc(s.contact_phone || "")}">
    <label style="margin-top:12px">Online buying</label>
    <label class="row" style="gap:8px;font-weight:400"><input type="checkbox" id="sOnline" style="width:auto" ${s.online_ok ? "checked" : ""}> Let people buy online (needs Stripe connected)</label>
    <label class="row" style="gap:8px;font-weight:400"><input type="checkbox" id="sPickup" style="width:auto" ${s.pickup_ok ? "checked" : ""}> Buyers can pick up at the sale</label>
    <label class="row" style="gap:8px;font-weight:400"><input type="checkbox" id="sShip" style="width:auto" ${s.ship_ok ? "checked" : ""}> I'll ship items that have a shipping price</label>
    <div style="height:10px"></div><button class="btn" id="sSave">${sale ? "Save" : "Create sale"}</button></div>`;
  $("#sSave").onclick = async () => {
    const body = {
      kind: $("#sKind").value, title: $("#sTitle").value, starts_on: $("#sStart").value, ends_on: $("#sEnd").value, hours: $("#sHours").value,
      street: $("#sStreet").value, city: $("#sCity").value, state: $("#sState").value, zip: $("#sZip").value, description: $("#sDesc").value,
      contact_phone: $("#sPhone").value, online_ok: $("#sOnline").checked, pickup_ok: $("#sPickup").checked, ship_ok: $("#sShip").checked,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    $("#sSave").disabled = true;
    try {
      if (sale) { await api("/garage/sales/" + sale.id, { method: "PATCH", body: JSON.stringify(body) }); toast("Saved"); renderSale(sale.id); }
      else { const { id } = await api("/garage/sales", { method: "POST", body: JSON.stringify(body) }); toast("Sale created"); then ? then(id) : renderSale(id); }
    } catch (e) { toast(e.message); $("#sSave").disabled = false; }
  };
}

// ---------- one sale ----------
async function renderSale(id) {
  state.view = "sale"; state.saleId = id; setChrome(); backTo(renderSales);
  app.innerHTML = `<div class="muted" style="padding:14px">Loading…</div>`;
  let d;
  try { d = await api("/garage/sales/" + id); } catch (e) { app.innerHTML = `<div class="muted" style="padding:14px">${esc(e.message)}</div>`; return; }
  const { sale: s, items, holds, orders, payments } = d;
  ctx.textContent = SALE_KINDS[s.kind] || "Sale";
  const onlineOn = s.online_ok && payments.platform_on && payments.ready;
  const newHolds = holds.filter(h => h.status === "new" || h.status === "accepted");
  const openOrders = orders.filter(o => ["paid", "refund_needed"].includes(o.status));
  const itemName = iid => { const it = items.find(i => i.item_id === iid); return it ? (it.ai_title || it.name) : "item"; };
  const addr = o => { try { const a = JSON.parse(o.ship_address || "null"); if (!a || !a.address) return a && a.phone ? `Phone ${a.phone}` : ""; const x = a.address;
    return `${a.name || ""}, ${x.line1 || ""}${x.line2 ? " " + x.line2 : ""}, ${x.city || ""}, ${x.state || ""} ${x.postal_code || ""}${a.phone ? " · " + a.phone : ""}`; } catch { return ""; } };
  app.innerHTML = `
    <div class="card" style="border-color:var(--green)">
      <h1 class="h1" style="margin:0 0 2px">${esc(s.title)}</h1>
      <div class="muted" style="font-size:.88rem">${esc(saleWhen(s))} · ${esc(s.street ? s.street + ", " : "")}${esc(s.city)}, ${esc(s.state)}</div>
      <div style="margin:8px 0"><span class="pill">${s.status === "draft" ? "draft — only you can see it" : s.status === "ended" ? "ended" : "published · " + (PHASE[s.phase] || "")}</span>
        ${s.online_ok ? `<span class="pill" style="${onlineOn ? "background:var(--cobalt);color:#fff" : ""}">${onlineOn ? "online buying on" : "online buying waiting on Stripe"}</span>` : ""}</div>
      <div class="muted" style="font-size:.8rem;word-break:break-all">${esc(s.url)}</div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px">
        ${s.status !== "published" ? `<button class="btn sm" id="pub">Publish</button>` : `<button class="btn sm" id="share">Share link</button>`}
        <a class="btn sec sm" href="${esc(s.url)}" target="_blank" rel="noopener" style="text-decoration:none">View page</a>
        <a class="btn sec sm" href="/sale/${esc(s.slug)}/tags" target="_blank" rel="noopener" style="text-decoration:none">Print price tags</a>
        ${typeof isNative !== "undefined" && isNative ? "" : `<a class="btn sec sm" href="/api/garage/sales/${esc(s.id)}/export.xlsx" download style="text-decoration:none">Export to Excel</a>
        <a class="btn sec sm" href="/api/garage/sales/${esc(s.id)}/export.csv" download style="text-decoration:none">Export CSV</a>`}
        <button class="btn sec sm" id="edit">Edit details</button>
      </div>
    </div>
    ${s.online_ok && !payments.ready ? `<div id="stripeCard">${stripeCardHtml(payments.platform_on ? { connected: payments.connected, ready: false } : { off: true })}</div>` : ""}
    ${newHolds.length ? `<h3 style="margin:14px 2px 6px">Hold requests</h3><div class="list">${newHolds.map(h => `<div class="li" style="align-items:flex-start">
        <div style="min-width:0;flex:1"><div class="nm">${esc(h.name)} · <a href="tel:${esc(h.phone.replace(/[^\d+]/g, ""))}">${esc(h.phone)}</a></div>
        <div class="muted" style="font-size:.8rem">${esc(itemName(h.item_id))}${h.note ? " — " + esc(h.note) : ""}</div>
        <div class="row" style="gap:6px;margin-top:6px">${h.status === "new" ? `<button class="btn sm" data-hold="${h.id}" data-st="accepted">Hold it</button><button class="btn sec sm" data-hold="${h.id}" data-st="declined">Decline</button>`
          : `<span class="pill" style="background:#fde7c7">on hold</span><button class="btn sec sm" data-hold="${h.id}" data-st="done">Release / done</button>`}</div></div></div>`).join("")}</div>` : ""}
    ${openOrders.length ? `<h3 style="margin:14px 2px 6px">Online orders</h3><div class="list">${openOrders.map(o => `<div class="li" style="align-items:flex-start">
        <div style="min-width:0;flex:1"><div class="nm">${esc(itemName(o.item_id))} · ${money(o.total_cents)}</div>
        <div class="muted" style="font-size:.8rem">${esc(o.buyer_name || "")} ${esc(o.buyer_email || "")} · ${o.fulfilment === "ship" ? "SHIP" : "pickup"} · you get ${money(o.total_cents - o.fee_cents)} before Stripe's card fee</div>
        ${o.fulfilment === "ship" ? `<div class="muted" style="font-size:.8rem">${esc(addr(o))}</div>` : ""}
        ${o.status === "refund_needed" ? `<div style="color:var(--rust);font-size:.82rem;margin-top:4px">${esc(o.note || "Refund this buyer in Stripe.")}</div>`
          : `<div class="row" style="gap:6px;margin-top:6px">${o.fulfilment === "ship" ? `<input data-track="${o.id}" placeholder="Tracking # (optional)" style="flex:1;min-width:120px">` : ""}<button class="btn sm" data-done="${o.id}">${o.fulfilment === "ship" ? "Mark shipped" : "Picked up"}</button></div>`}
        <a class="btn sec sm" href="/sale/${esc(s.slug)}/slip/${esc(o.id)}" target="_blank" rel="noopener" style="text-decoration:none;margin-top:6px;display:inline-block">🖨 ${o.fulfilment === "ship" ? "Packing slip" : "Pickup receipt"}</a>
        ${o.fulfilment === "ship" && o.status === "paid" ? labelBtnHtml("garage", o.id) : ""}
        </div></div>`).join("")}</div>` : ""}
    <div class="row" style="justify-content:space-between;margin:14px 2px 6px"><h3>Items (${items.length})</h3><button class="btn sm" id="addItems">＋ Add items</button></div>
    <div class="list">${items.map(i => `<div class="li" style="align-items:flex-start;${i.status === "sold" ? "opacity:.55" : ""}">
        ${i.thumb ? `<img src="${esc(i.thumb)}" alt="" style="width:52px;height:52px;object-fit:cover;border-radius:8px">` : `<span style="width:52px;text-align:center">📦</span>`}
        <div style="min-width:0;flex:1"><div class="nm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.ai_title || i.name)}</div>
          <div class="muted" style="font-size:.8rem">Tag ${money(i.price_cents)}${i.online_price_cents != null ? ` · online ${money(i.online_price_cents)}` : ""}${i.ship_cents != null ? ` · ship ${i.ship_cents ? money(i.ship_cents) : "free"}` : " · pickup only"}</div>
          <div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap">
            <span class="pill">${i.status}</span>
            <button class="btn sec sm" data-price="${i.item_id}">Prices</button>
            ${i.status === "sold" ? `<button class="btn sec sm" data-st2="${i.item_id}" data-v="available">Not sold</button>` : i.status === "available" ? `<button class="btn sec sm" data-st2="${i.item_id}" data-v="sold">Sold</button>` : ""}
            <button class="btn sec sm" data-rm="${i.item_id}" style="color:var(--rust)">Remove</button></div></div></div>`).join("") || `<div class="empty">No items yet. Add things you've guestimated.</div>`}</div>
    <div class="row" style="gap:8px;margin:16px 0;flex-wrap:wrap">
      ${s.status === "published" ? `<button class="btn sec sm" id="unpub">Unpublish</button><button class="btn sec sm" id="endSale">Mark ended</button>` : ""}
      <button class="btn sec sm" id="delSale" style="color:var(--rust)">Delete sale</button></div>`;

  const patch = async (body, msg) => { try { await api("/garage/sales/" + id, { method: "PATCH", body: JSON.stringify(body) }); if (msg) toast(msg); renderSale(id); } catch (e) { toast(e.message); } };
  if ($("#pub")) $("#pub").onclick = () => patch({ status: "published" }, "Published");
  if ($("#unpub")) $("#unpub").onclick = () => patch({ status: "draft" }, "Unpublished");
  if ($("#endSale")) $("#endSale").onclick = () => confirm("Mark this sale ended? The page stays up but nothing can be held or bought.") && patch({ status: "ended" }, "Ended");
  $("#edit").onclick = () => renderSaleForm(s);
  if ($("#share")) $("#share").onclick = async () => {
    const text = `${s.title} — ${saleWhen(s)}, ${s.city}, ${s.state}`;
    try { if (navigator.share) await navigator.share({ title: s.title, text, url: s.url }); else { await navigator.clipboard.writeText(s.url); toast("Link copied"); } } catch {}
  };
  wireStripeCard(() => renderSale(id));
  wireLabels(app, () => renderSale(id));
  $("#delSale").onclick = async () => {
    if (!confirm("Delete this sale page? Your items stay in Guestimator.")) return;
    try { await api("/garage/sales/" + id, { method: "DELETE" }); toast("Sale deleted"); renderSales(); } catch (e) { toast(e.message); }
  };
  $("#addItems").onclick = () => renderAddItems(id, items.map(i => i.item_id));
  app.querySelectorAll("[data-hold]").forEach(b => b.onclick = async () => {
    try { await api("/garage/holds/" + b.dataset.hold, { method: "PATCH", body: JSON.stringify({ status: b.dataset.st }) }); renderSale(id); } catch (e) { toast(e.message); }
  });
  app.querySelectorAll("[data-done]").forEach(b => b.onclick = async () => {
    const t = app.querySelector(`[data-track="${b.dataset.done}"]`);
    try { await api("/garage/orders/" + b.dataset.done, { method: "PATCH", body: JSON.stringify({ status: "fulfilled", tracking: t ? t.value : "" }) }); toast("Done"); renderSale(id); } catch (e) { toast(e.message); }
  });
  app.querySelectorAll("[data-st2]").forEach(b => b.onclick = async () => {
    try {
      const r = await api(`/garage/sales/${id}/items/${b.dataset.st2}`, { method: "PATCH", body: JSON.stringify({ status: b.dataset.v }) });
      if (r.ebay) toast(r.ebay.ended ? "Sold, and taken off eBay ✓" : `Sold here, but it's still on eBay: ${r.ebay.why}. End it in eBay so it can't sell twice.`);
      renderSale(id);
    } catch (e) { toast(e.message); }
  });
  app.querySelectorAll("[data-rm]").forEach(b => b.onclick = async () => {
    if (!confirm("Take this item out of the sale? It stays in your items.")) return;
    try { await api(`/garage/sales/${id}/items/${b.dataset.rm}`, { method: "DELETE" }); renderSale(id); } catch (e) { toast(e.message); }
  });
  app.querySelectorAll("[data-price]").forEach(b => b.onclick = () => renderPriceEditor(id, items.find(i => i.item_id === b.dataset.price), s));
}

function renderPriceEditor(saleId, i, s) {
  state.view = "salePrice"; setChrome(); backTo(() => renderSale(saleId));
  ctx.textContent = "Prices";
  app.innerHTML = `<div class="card"><b>${esc(i.ai_title || i.name)}</b>
    <label>Tag price at the sale ($)</label><input id="pTag" inputmode="decimal" value="${dollars(i.price_cents)}">
    <label>Online price ($, optional)</label><input id="pOnline" inputmode="decimal" value="${dollars(i.online_price_cents)}" placeholder="Same as the tag">
    <div class="muted" style="font-size:.8rem">Many sellers charge a little more online to cover card fees and packing. Show buyers the real price; a "was" price that was never charged isn't allowed.</div>
    <label>Shipping ($, optional)</label><input id="pShip" inputmode="decimal" value="${dollars(i.ship_cents)}" placeholder="Blank = pickup only · 0 = free shipping">
    ${!s.ship_ok ? `<div class="muted" style="font-size:.8rem">Shipping is off for this sale. Turn it on in Edit details.</div>` : ""}
    <div class="row" style="gap:8px;margin-top:6px;align-items:center"><input id="pZip" inputmode="numeric" maxlength="5" value="${esc(s.zip || "")}" placeholder="Ship-from ZIP" style="max-width:130px">
      <button class="btn sec sm" id="pQuote" type="button">💲 Get real shipping prices</button></div>
    <div id="pQuoteOut"></div>
    <div style="height:10px"></div><button class="btn" id="pSave">Save prices</button></div>`;
  $("#pQuote").onclick = () => getShipQuote(i.item_id, $("#pZip").value, $("#pQuote"), $("#pQuoteOut"), $("#pShip"));
  $("#pSave").onclick = async () => {
    try {
      await api(`/garage/sales/${saleId}/items/${i.item_id}`, { method: "PATCH", body: JSON.stringify({ price: $("#pTag").value, online_price: $("#pOnline").value, ship: $("#pShip").value }) });
      toast("Saved"); renderSale(saleId);
    } catch (e) { toast(e.message); }
  };
}

async function renderAddItems(saleId, have) {
  state.view = "saleAdd"; setChrome(); backTo(() => renderSale(saleId));
  ctx.textContent = "Add items";
  app.innerHTML = `<div class="muted" style="padding:14px">Loading…</div>`;
  let list = [];
  try { list = await api("/items"); } catch (e) { app.innerHTML = `<div class="muted" style="padding:14px">${esc(e.message)}</div>`; return; }
  list = list.filter(i => !have.includes(i.id));
  app.innerHTML = `<div class="muted" style="font-size:.85rem;margin:10px 2px">Tap to add. Each item starts at its guestimated price; change it any time.</div>
    <div class="list">${list.map(i => `<div class="li tap" data-add="${i.id}">
      ${i.thumb_key ? `<img src="/p/${esc(i.thumb_key)}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:8px">` : `<span style="width:48px;text-align:center">📦</span>`}
      <div class="nm" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.ai_title || i.name)}</div><span class="pr">＋</span></div>`).join("")
      || `<div class="empty">Every item is already in this sale. Guestimate something new from the home screen.</div>`}</div>
    <div style="height:12px"></div><button class="btn" id="addDone">Done</button>`;
  $("#addDone").onclick = () => renderSale(saleId);
  app.querySelectorAll("[data-add]").forEach(li => li.onclick = async () => {
    li.style.opacity = ".5";
    try { const r = await api(`/garage/sales/${saleId}/items`, { method: "POST", body: JSON.stringify({ item_id: li.dataset.add }) });
      li.querySelector(".pr").textContent = "✓ " + money(r.price_cents); li.onclick = null; }
    catch (e) { li.style.opacity = ""; toast(e.message); }
  });
}

// ---------- from an item: "Put it in a sale" ----------
function salePanelHtml() {
  return `<div class="card" style="border-color:var(--green)"><label>Or sell it yourself</label>
    <div class="muted" style="font-size:.85rem;margin-bottom:10px">Put it in a free garage or estate sale page with its price, a printable tag, and holds.</div>
    <button class="btn" id="toSale">Add to a sale</button></div>`;
}
async function addItemToSale(itemId) {
  let list = [];
  try { list = (await api("/garage/sales")).filter(s => s.status !== "ended"); } catch (e) { return toast(e.message); }
  const addTo = async sid => {
    try { const r = await api(`/garage/sales/${sid}/items`, { method: "POST", body: JSON.stringify({ item_id: itemId }) }); toast(`Added at ${money(r.price_cents)}`); renderSale(sid); }
    catch (e) { toast(e.message); }
  };
  if (!list.length) return renderSaleForm(null, addTo);
  state.view = "salePick"; setChrome(); backTo(() => renderItemDetail(itemId));
  ctx.textContent = "Add to a sale";
  app.innerHTML = `<div class="list">${list.map(s => `<div class="li tap" data-pick="${s.id}"><div class="nm">${esc(s.title)}<div class="muted" style="font-size:.8rem">${esc(saleWhen(s))}</div></div><span class="pr">＋</span></div>`).join("")}</div>
    <div style="height:12px"></div><button class="btn sec" id="pickNew">＋ New sale</button>`;
  app.querySelectorAll("[data-pick]").forEach(li => li.onclick = () => addTo(li.dataset.pick));
  $("#pickNew").onclick = () => renderSaleForm(null, addTo);
}

// Back from Stripe's hosted onboarding (#stripe-return) or an expired link (#stripe-refresh).
async function afterStripeReturn() {
  const h = location.hash;
  // "Open my sale" in a hold / sold-online email lands here.
  if (h === "#sales") { history.replaceState(null, "", "/"); await renderSales(); return true; }
  if (h !== "#stripe-return" && h !== "#stripe-refresh") return false;
  history.replaceState(null, "", "/");
  await renderSales();
  const s = await loadStripeStatus();
  toast(s.ready ? "Stripe connected. Online buying is on." : h === "#stripe-refresh" ? "That link expired. Tap Finish Stripe setup again." : "Stripe still needs a few details.");
  return true;
}
window.addEventListener("hashchange", afterStripeReturn);

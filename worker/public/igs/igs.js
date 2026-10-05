// Instant Garage Sale: the sale comes first, then the items. Same accounts and backend as
// Guestimator (/api/*): a sale is a garage_sales row, each item a Guestimator item placed in it.
// Quick add is free (photo, name, price); "Guestimate it" is optional and uses 1 credit.
"use strict";
const $ = s => document.querySelector(s);
const app = $("#app");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = c => "$" + (Number(c || 0) / 100).toFixed(2).replace(/\.00$/, "");
const GUESTIMATOR = "https://app.theguestimator.com/";
const KINDS = { garage: "Garage sale", yard: "Yard sale", estate: "Estate sale", moving: "Moving sale" };
let me = null, cfg = null;

function toast(msg, ms = 2600) {
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; t.setAttribute("role", "status");
  document.body.appendChild(t); setTimeout(() => t.remove(), ms);
}
async function api(path, opts = {}) {
  const o = { credentials: "same-origin", ...opts };
  if (o.body && !(o.body instanceof FormData)) o.headers = { "content-type": "application/json", ...(o.headers || {}) };
  const r = await fetch("/api" + path, o);
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error((j && j.error) || `Something went wrong (${r.status})`); e.status = r.status; e.body = j; throw e; }
  return j;
}
const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const fmtDay = d => new Date(d + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const dates = s => s.starts_on === s.ends_on ? fmtDay(s.starts_on) : `${fmtDay(s.starts_on)} – ${fmtDay(s.ends_on)}`;
const statusChip = s => s.status === "published" ? `<span class="chip live">Live</span>` : s.status === "ended" ? `<span class="chip">Ended</span>` : `<span class="chip">Draft</span>`;

// ---------- sign in ----------
function renderAuth(mode = "register") {
  $("#signout").hidden = true;
  app.innerHTML = `
  <section class="hero"><h1>Your garage sale, <em>online</em> in five minutes.</h1>
    <p class="muted" style="margin-top:10px">Snap each thing, stick a price on it, share one link. Neighbors see what you've got before they drive over.</p></section>
  <div class="steps">
    <div class="step"><b>1</b><span>Name your sale and pick the days</span></div>
    <div class="step"><b>2</b><span>Photo + price for each item — a few seconds each</span></div>
    <div class="step"><b>3</b><span>Share the link, print QR price stickers, export your list to Excel</span></div>
  </div>
  <div class="card">
    <h2 style="font-size:1.35rem">${mode === "register" ? "Start your sale" : "Welcome back"}</h2>
    <form id="authF" autocomplete="on">
      <label for="em">Email</label><input type="email" id="em" autocomplete="email" required>
      <label for="pw">Password</label><input type="password" id="pw" autocomplete="${mode === "register" ? "new-password" : "current-password"}" minlength="8" required>
      <div style="height:12px"></div>
      <button class="btn" id="authGo">${mode === "register" ? "Create my free account" : "Sign in"}</button>
    </form>
    <div id="gWrap" style="margin-top:12px;display:grid;justify-items:center" hidden><div id="gBtn"></div></div>
    <p class="small muted" style="text-align:center;margin:12px 0 0">${mode === "register"
      ? `Already have an account (Guestimator works too)? <a href="#" id="swap">Sign in</a>`
      : `New here? <a href="#" id="swap">Create an account</a>`}</p>
  </div>
  <p class="foot">Sale pages are free. Optional AI price guesses use credits. Instant Garage Sale is made by the team behind <a href="${GUESTIMATOR}" target="_blank" rel="noopener">Guestimator</a>.</p>`;
  $("#swap").onclick = e => { e.preventDefault(); renderAuth(mode === "register" ? "login" : "register"); };
  $("#authF").onsubmit = async e => {
    e.preventDefault();
    const b = $("#authGo"); b.disabled = true;
    try {
      await api(`/auth/${mode}`, { method: "POST", body: JSON.stringify({ email: $("#em").value, password: $("#pw").value }) });
      await start();
    } catch (err) { toast(err.message); b.disabled = false; }
  };
  mountGoogle();
}
async function mountGoogle() {
  try { cfg = cfg || await api("/auth/config"); } catch { return; }
  if (!cfg.google_client_id) return;
  try {
    await new Promise((res, rej) => { if (window.google?.accounts?.id) return res(); const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    // iPhone/iPad Safari: the popup fails ("400. That's an error"), so use Google's redirect mode
    // there once it's switched on server-side (cfg.google_redirect).
    const appleTouch = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    if (cfg.google_redirect && appleTouch) google.accounts.id.initialize({ client_id: cfg.google_client_id, ux_mode: "redirect", login_uri: location.origin + "/api/auth/google/redirect" });
    else google.accounts.id.initialize({ client_id: cfg.google_client_id, ux_mode: "popup", callback: async r => {
      try { await api("/auth/google", { method: "POST", body: JSON.stringify({ credential: r.credential }) }); await start(); } catch (e) { toast(e.message); } } });
    $("#gWrap").hidden = false;
    google.accounts.id.renderButton($("#gBtn"), { theme: "outline", size: "large", text: "continue_with", shape: "pill", width: 280 });
  } catch { /* password sign-in still works */ }
}

// ---------- your sales ----------
async function renderSales() {
  app.innerHTML = `<p class="muted">Loading your sales…</p>`;
  let list;
  try { list = await api("/garage/sales"); } catch (e) { if (e.status === 401) return renderAuth("login"); app.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  if (!list.length) return renderSaleForm();   // sale first: a new seller goes straight to naming one
  app.innerHTML = `<div class="stack">
    <h1 style="font-size:1.8rem">Your sales</h1>
    ${list.map(s => `<button class="sale-row" data-id="${esc(s.id)}"><span style="min-width:0"><b style="display:block;overflow-wrap:anywhere">${esc(s.title)}</b>
      <span class="small muted">${esc(dates(s))} · ${esc(s.city)}, ${esc(s.state)} · ${s.items} item${s.items === 1 ? "" : "s"}</span></span>${statusChip(s)}</button>`).join("")}
    <button class="btn" id="newSale">Start a new sale</button></div>`;
  app.querySelectorAll("[data-id]").forEach(b => b.onclick = () => renderSale(b.dataset.id));
  $("#newSale").onclick = () => renderSaleForm();
}

// ---------- name the sale (new, or edit) ----------
function renderSaleForm(sale) {
  const s = sale || { kind: "garage", starts_on: todayISO(), ends_on: todayISO(), pickup_ok: 1, ship_ok: 0 };
  const opt = (v, t, cur) => `<option value="${v}" ${v === cur ? "selected" : ""}>${t}</option>`;
  app.innerHTML = `<div class="card">
    <h1 style="font-size:1.6rem">${sale ? "Sale details" : "Step 1: your sale"}</h1>
    <p class="small muted" style="margin:6px 0 0">${sale ? "" : "Items come next. You can change any of this later."}</p>
    <form id="saleF">
      <label for="title">Sale name</label><input id="title" maxlength="90" required placeholder="Big Saturday garage sale" value="${esc(s.title || "")}">
      <div class="row"><div><label for="kind">Kind</label><select id="kind">${Object.entries(KINDS).map(([k, t]) => opt(k, t, s.kind)).join("")}</select></div>
        <div><label for="hours">Hours</label><input id="hours" maxlength="80" placeholder="8am – 2pm" value="${esc(s.hours || "")}"></div></div>
      <div class="row"><div><label for="d1">First day</label><input type="date" id="d1" required value="${esc(s.starts_on)}"></div>
        <div><label for="d2">Last day</label><input type="date" id="d2" required value="${esc(s.ends_on)}"></div></div>
      <div class="row"><div><label for="city">City</label><input id="city" maxlength="60" required value="${esc(s.city || "")}"></div>
        <div style="flex:0 1 90px"><label for="st">State</label><input id="st" maxlength="2" required placeholder="NJ" value="${esc(s.state || "")}" style="text-transform:uppercase"></div>
        <div style="flex:0 1 120px"><label for="zip">ZIP</label><input id="zip" inputmode="numeric" maxlength="10" value="${esc(s.zip || "")}"></div></div>
      <label for="street">Street address <span class="muted" style="font-weight:400">(hidden until the first day)</span></label><input id="street" maxlength="120" value="${esc(s.street || "")}">
      <label for="desc">Anything shoppers should know?</label><textarea id="desc" rows="2" maxlength="2000" placeholder="Cash and Venmo. Lots of tools and kids' stuff.">${esc(s.description || "")}</textarea>
      <label class="check"><input type="checkbox" id="pick" ${s.pickup_ok ? "checked" : ""}> People can ask me to hold things for pickup</label>
      <div style="height:14px"></div>
      <button class="btn" id="saleGo">${sale ? "Save" : "Next: add items"}</button>
      ${sale ? `<div style="height:8px"></div><button type="button" class="btn sec" id="cancel">Back to the sale</button>` : ""}
    </form></div>`;
  if (sale) $("#cancel").onclick = () => renderSale(sale.id);
  $("#saleF").onsubmit = async e => {
    e.preventDefault();
    const body = { title: $("#title").value, kind: $("#kind").value, hours: $("#hours").value, starts_on: $("#d1").value, ends_on: $("#d2").value || $("#d1").value,
      city: $("#city").value, state: $("#st").value, zip: $("#zip").value, street: $("#street").value, description: $("#desc").value,
      pickup_ok: $("#pick").checked, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
    const b = $("#saleGo"); b.disabled = true;
    try {
      if (sale) { await api("/garage/sales/" + sale.id, { method: "PATCH", body: JSON.stringify(body) }); toast("Saved"); renderSale(sale.id); }
      else { const { id } = await api("/garage/sales", { method: "POST", body: JSON.stringify(body) }); await renderSale(id); openAdd(id); }
    } catch (err) { toast(err.message); b.disabled = false; }
  };
}

// ---------- one sale: items first, everything else underneath ----------
let current = null, pollT = null;
async function renderSale(id, { quiet } = {}) {
  clearTimeout(pollT);
  if (!quiet) app.innerHTML = `<p class="muted">Loading…</p>`;
  let d;
  try { d = await api("/garage/sales/" + id); } catch (e) { if (e.status === 401) return renderAuth("login"); app.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  current = d;
  const s = d.sale, items = d.items;
  const unsold = items.filter(i => i.status !== "sold"), sold = items.filter(i => i.status === "sold");
  const sum = a => a.reduce((n, i) => n + (i.price_cents || 0), 0);
  const holds = (d.holds || []).filter(h => h.status === "new");
  const byItem = Object.fromEntries(items.map(i => [i.item_id, i]));
  app.innerHTML = `<div class="stack">
    <div><button class="link" id="back" style="padding-left:0">‹ All sales</button>
      <h1 style="font-size:1.75rem;overflow-wrap:anywhere">${esc(s.title)}</h1>
      <p class="small muted" style="margin:4px 0 0">${esc(KINDS[s.kind] || "Sale")} · ${esc(dates(s))}${s.hours ? " · " + esc(s.hours) : ""} · ${esc(s.city)}, ${esc(s.state)} ${statusChip(s)}</p></div>
    <div class="stats"><div><b>${unsold.length}</b><span>for sale · ${money(sum(unsold))}</span></div><div><b>${sold.length}</b><span>sold · ${money(sum(sold))}</span></div><div><b>${holds.length}</b><span>hold request${holds.length === 1 ? "" : "s"}</span></div></div>
    ${holds.length ? `<div class="card"><h3>Hold requests</h3>${holds.map(h => `<div class="item"><div class="body"><div class="name">${esc(h.name)} · <a href="tel:${esc(h.phone)}">${esc(h.phone)}</a></div>
      <div class="small muted">wants ${esc(byItem[h.item_id]?.ai_title || byItem[h.item_id]?.name || "an item")}${h.note ? ` — “${esc(h.note)}”` : ""}</div>
      <div class="acts"><button class="btn sm" data-hold="${esc(h.id)}" data-v="accepted">Hold it</button><button class="btn sm sec" data-hold="${esc(h.id)}" data-v="declined">Decline</button></div></div></div>`).join("")}</div>` : ""}
    <div class="card"><div class="row" style="align-items:center"><h3 style="flex:1 1 auto">Items</h3><span class="small muted" style="flex:0 0 auto">Tap a price to change it</span></div>
      ${items.length ? items.map(itemRow).join("") : `<p class="muted" style="margin:10px 0 0">Nothing here yet. Tap <b>Add an item</b> and snap your first thing.</p>`}</div>
    <div class="addbar"><button class="btn" id="add">＋ Add an item</button></div>
    <div class="card stack" style="gap:10px">
      <h3>Share and sell</h3>
      ${s.status === "published"
        ? `<p class="small" style="margin:0">Your sale page is live:</p><div class="row" style="align-items:center"><input id="shareUrl" readonly value="${esc(s.url)}" style="flex:1 1 220px"><button class="btn sm" id="copyUrl" style="flex:0 0 auto">Copy link</button></div>
           <a class="btn sec" href="${esc(s.url)}" target="_blank" rel="noopener">Open my sale page ↗</a>`
        : `<p class="small muted" style="margin:0">Your sale is a draft. Publishing makes the page public so you can share the link.</p><button class="btn" id="publish">Publish my sale</button>`}
      <div class="tools">
        <a class="btn sec" href="/sale/${esc(s.slug)}/tags" target="_blank" rel="noopener">Print QR price stickers</a>
        <button class="btn sec" id="edit">Edit sale details</button>
        <a class="btn sec" href="/api/garage/sales/${esc(s.id)}/export.xlsx" download>Export to Excel</a>
        <a class="btn sec" href="/api/garage/sales/${esc(s.id)}/export.csv" download>Export CSV</a>
      </div>
      ${s.status === "published" ? `<button class="link" id="unpublish">Take the page down (back to draft)</button>` : ""}
      ${s.status !== "ended" ? `<button class="link" id="endSale">Sale's over — mark it ended</button>` : ""}
    </div></div>`;
  $("#back").onclick = () => renderSales();
  $("#add").onclick = () => openAdd(s.id);
  $("#edit").onclick = () => renderSaleForm(s);
  const setStatus = async (status, msg) => { try { await api("/garage/sales/" + s.id, { method: "PATCH", body: JSON.stringify({ status }) }); toast(msg); renderSale(s.id, { quiet: true }); } catch (e) { toast(e.message); } };
  if ($("#publish")) $("#publish").onclick = () => setStatus("published", "Your sale is live 🎉");
  if ($("#unpublish")) $("#unpublish").onclick = () => setStatus("draft", "Back to draft — the page is hidden");
  if ($("#endSale")) $("#endSale").onclick = () => setStatus("ended", "Marked ended");
  if ($("#copyUrl")) $("#copyUrl").onclick = async () => { try { await navigator.clipboard.writeText(s.url); toast("Link copied"); } catch { $("#shareUrl").select(); toast("Press Copy on your keyboard"); } };
  app.querySelectorAll("[data-hold]").forEach(b => b.onclick = async () => {
    try { await api("/garage/holds/" + b.dataset.hold, { method: "PATCH", body: JSON.stringify({ status: b.dataset.v }) }); toast(b.dataset.v === "accepted" ? "Held — call or text them" : "Declined"); renderSale(s.id, { quiet: true }); }
    catch (e) { toast(e.message); } });
  wireItems(s.id);
  if (items.some(i => i.guess && i.guess.status === "pending")) pollT = setTimeout(() => { if (current && current.sale.id === s.id) renderSale(s.id, { quiet: true }); }, 5000);
}

function itemRow(i) {
  const g = i.guess;
  const guessLine = !g ? "" : g.status === "pending" ? `<div class="guess">Guestimating… about 2 minutes</div>`
    : g.status === "done" && g.low && g.high ? `<div class="guess">Guestimate $${Math.round(g.low)}–$${Math.round(g.high)} <button class="link" data-use="${esc(i.item_id)}" data-c="${Math.round((g.low + g.high) / 2 * 100)}" style="padding:0 4px;color:var(--blue)">use $${Math.round((g.low + g.high) / 2)}</button></div>`
    : g.status === "error" ? `<div class="guess">Couldn't guess this one (credit refunded)</div>` : "";
  return `<div class="item">
    ${i.thumb ? `<img class="thumb" src="${esc(i.thumb)}" alt="" loading="lazy">` : `<div class="thumb"></div>`}
    <div class="body"><div class="name">${esc(i.ai_title || i.name)}</div>
      ${i.status === "held" ? `<span class="chip held">On hold</span>` : i.status === "pending" ? `<span class="chip">Being bought online</span>` : ""}
      ${guessLine}
      <div class="acts">
        ${i.status === "sold" ? `<button class="btn sm sec" data-st="${esc(i.item_id)}" data-v="available">Undo sold</button>`
          : `<button class="btn sm sec" data-st="${esc(i.item_id)}" data-v="sold">Sold</button>`}
        ${!g || g.status === "error" ? `<button class="btn sm sec" data-ai="${esc(i.item_id)}">Guestimate it</button>` : ""}
        <button class="btn sm sec" data-rm="${esc(i.item_id)}" aria-label="Remove from sale">Remove</button>
      </div></div>
    <button class="dot ${i.status === "sold" ? "sold" : ""}" data-price="${esc(i.item_id)}" aria-label="Price ${money(i.price_cents)}, tap to change">${i.status === "sold" ? "SOLD" : money(i.price_cents)}</button>
  </div>`;
}

function wireItems(sid) {
  const patch = async (iid, body, msg) => {
    try { const r = await api(`/garage/sales/${sid}/items/${iid}`, { method: "PATCH", body: JSON.stringify(body) }); if (msg) toast(msg);
      if (r && r.ebay && r.ebay.ended) toast("Sold — and taken off eBay"); renderSale(sid, { quiet: true }); }
    catch (e) { toast(e.message); }
  };
  app.querySelectorAll("[data-st]").forEach(b => b.onclick = () => patch(b.dataset.st, { status: b.dataset.v }, b.dataset.v === "sold" ? "Marked sold" : "Back on sale"));
  app.querySelectorAll("[data-use]").forEach(b => b.onclick = () => patch(b.dataset.use, { price: (Number(b.dataset.c) / 100).toFixed(2) }, "Price updated"));
  app.querySelectorAll("[data-price]").forEach(b => b.onclick = () => {
    const it = current.items.find(i => i.item_id === b.dataset.price); if (!it) return;
    sheet(`<form class="sheet" id="pf"><h2 style="font-size:1.3rem">New price</h2><p class="small muted" style="margin:0 0 6px;overflow-wrap:anywhere">${esc(it.ai_title || it.name)}</p>
      <label for="np">Price ($)</label><input id="np" inputmode="decimal" value="${(it.price_cents / 100).toFixed(2).replace(/\.00$/, "")}">
      <div class="row" style="margin-top:12px"><button type="button" class="btn sec" id="pc">Cancel</button><button class="btn">Save price</button></div></form>`);
    $("#np").select();
    $("#pc").onclick = closeSheet;
    $("#pf").onsubmit = e => { e.preventDefault(); closeSheet(); patch(it.item_id, { price: $("#np").value.replace(/[$,\s]/g, "") }, "Price updated"); };
  });
  app.querySelectorAll("[data-rm]").forEach(b => b.onclick = async () => {
    if (!confirm("Take this item out of the sale?")) return;
    try { await api(`/garage/sales/${sid}/items/${b.dataset.rm}`, { method: "DELETE" }); toast("Removed"); renderSale(sid, { quiet: true }); } catch (e) { toast(e.message); }
  });
  app.querySelectorAll("[data-ai]").forEach(b => b.onclick = async () => {
    const it = current.items.find(i => i.item_id === b.dataset.ai); if (!it) return;
    b.disabled = true; b.textContent = "Starting…";
    try {
      await api(`/items/${it.item_id}/appraise`, { method: "POST", body: JSON.stringify({ dealer_description: it.item_description || it.name }) });
      toast("Guestimating — about 2 minutes. You can keep adding items.");
      renderSale(sid, { quiet: true });
    } catch (e) {
      b.disabled = false; b.textContent = "Guestimate it";
      if (e.status === 402) return creditsSheet();
      if (e.body && e.body.needs_description) return toast("Give the item a name first (tap Remove and add it again with a name).");
      toast(e.message);
    }
  });
}
function creditsSheet() {
  sheet(`<div class="sheet"><h2 style="font-size:1.3rem">Guestimates use credits</h2>
    <p class="muted" style="margin:6px 0 10px">An AI price guess costs 1 credit. You're out right now. Credits are on your Guestimator account (same email and password), and they work here too.</p>
    <a class="btn" href="${GUESTIMATOR}" target="_blank" rel="noopener">Get credits in Guestimator ↗</a>
    <div style="height:8px"></div><button class="btn sec" id="ok">Not now</button>
    <p class="small muted" style="margin:10px 0 0">You don't need credits to run a sale. Prices you type in are always free.</p></div>`);
  $("#ok").onclick = closeSheet;
}
const dlg = $("#sheet");
function sheet(html) { dlg.innerHTML = html; if (!dlg.open) dlg.showModal(); }
function closeSheet() { if (dlg.open) dlg.close(); }

// ---------- quick add: photo, name, price; then straight on to the next one ----------
async function shrink(file) {
  // Phone photos are often 4-12 MB. 1600px on the long side is plenty for a sale page and uploads
  // fast on a driveway's mobile signal. Anything the browser can't decode (some HEIC) goes as is.
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (k === 1 && file.size < 2.5e6 && /jpe?g|png/i.test(file.type)) return file;
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.85));
    return blob ? new File([blob], "photo.jpg", { type: "image/jpeg" }) : file;
  } catch { return file; }
}
function openAdd(sid) {
  let photo = null, added = 0;
  const form = () => {
    sheet(`<form class="sheet" id="af">
      <div class="row" style="align-items:center"><h2 style="font-size:1.3rem;flex:1 1 auto">Add an item</h2><span class="small muted" style="flex:0 0 auto" id="cnt">${added ? `${added} added` : ""}</span></div>
      <label class="photo" id="ph"><span>📷 Tap to take a photo<br><small style="font-weight:400">or pick one</small></span><input type="file" id="pf" accept="image/*" capture="environment" aria-label="Photo"></label>
      <label for="nm">What is it?</label><input id="nm" maxlength="120" required placeholder="Kids' bike, 20 inch">
      <label for="pr">Price ($)</label><input id="pr" inputmode="decimal" required placeholder="10">
      <div class="row" style="margin-top:12px"><button type="button" class="btn sec" id="done">Done</button><button class="btn" id="save">Save &amp; add next</button></div>
    </form>`);
    $("#pf").onchange = async () => {
      const f = $("#pf").files[0]; if (!f) return;
      photo = await shrink(f);
      $("#ph").querySelector("span")?.remove(); $("#ph").querySelector("img")?.remove();
      const img = document.createElement("img"); img.alt = ""; img.src = URL.createObjectURL(photo); $("#ph").prepend(img);
      $("#nm").focus();
    };
    $("#done").onclick = () => { closeSheet(); renderSale(sid, { quiet: true }); };
    $("#af").onsubmit = async e => {
      e.preventDefault();
      const name = $("#nm").value.trim(), price = $("#pr").value.replace(/[$,\s]/g, "");
      if (!name) return toast("Say what it is");
      if (!(Number(price) >= 0) || price === "") return toast("Enter a price like 5 or 12.50");
      const b = $("#save"); b.disabled = true; b.textContent = "Saving…";
      try {
        const { id } = await api("/items", { method: "POST", body: JSON.stringify({ name, description: name }) });
        if (photo) { const fd = new FormData(); fd.append("photos", photo, photo.name || "photo.jpg"); fd.append("kinds", "front");
          await api(`/items/${id}/photos`, { method: "POST", body: fd }); }
        await api(`/garage/sales/${sid}/items`, { method: "POST", body: JSON.stringify({ item_id: id, price }) });
        added++; photo = null; toast(`Added ${name}`); form(); renderSale(sid, { quiet: true });
      } catch (err) { toast(err.message); b.disabled = false; b.textContent = "Save & add next"; }
    };
  };
  form();
}

// ---------- boot ----------
async function start() {
  try { const r = await fetch("/api/auth/me", { credentials: "same-origin" }); me = r.ok ? await r.json() : null; } catch { me = null; }
  if (!me) return renderAuth("register");
  $("#signout").hidden = false;
  renderSales();
}
$("#home").onclick = e => { e.preventDefault(); me ? renderSales() : renderAuth("register"); };
$("#signout").onclick = async () => { try { await api("/auth/logout", { method: "POST" }); } catch {} me = null; renderAuth("login"); };
start();

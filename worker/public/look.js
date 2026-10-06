// Guestimator — Appearance (light / dark / follow the phone; Classic or Black & white with a
// highlight color) and Feedback (send an idea or a problem, see what happened to it).
// Loaded after sales.js, before app.js; uses app.js globals ($, app, api, esc, toast, setChrome,
// state, renderHome) and sales.js's backTo. The look is per device (localStorage) and is applied
// before first paint by gsLook in index.html.

const LOOK_KEY = "gs-look";
const HIGHLIGHTS = [["#2563eb", "Blue"], ["#e11d48", "Red"], ["#f97316", "Orange"], ["#ca8a04", "Gold"],
                    ["#16a34a", "Green"], ["#0d9488", "Teal"], ["#7c3aed", "Purple"], ["#db2777", "Pink"]];
function getLook() { try { return JSON.parse(localStorage.getItem(LOOK_KEY) || "{}") || {}; } catch { return {}; } }
function setLook(L) {
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(L)); } catch {}
  if (window.gsLook) window.gsLook(L);
}
// Following the phone: re-apply when the phone switches between light and dark.
try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { const L = getLook(); if (!L.mode || L.mode === "system") window.gsLook && gsLook(L); }); } catch {}

function renderLook() {
  state.view = "look"; setChrome(); backTo(renderHome);
  ctx.textContent = "Appearance";
  const L = { mode: "system", skin: "classic", accent: "#2563eb", ...getLook() };
  const seg = (name, opts, cur) => `<div class="seg" data-seg="${name}">${opts.map(([v, t]) => `<button type="button" data-v="${v}" class="${cur === v ? "on" : ""}">${esc(t)}</button>`).join("")}</div>`;
  app.innerHTML = `<div class="card">
    <b>Light or dark</b>${seg("mode", [["system", "Match my phone"], ["light", "Light"], ["dark", "Dark"]], L.mode)}
    <div style="height:16px"></div>
    <b>Style</b>${seg("skin", [["classic", "Classic"], ["mono", "Black & white"]], L.skin)}
    <div id="hlBox" style="margin-top:16px;${L.skin === "mono" ? "" : "display:none"}">
      <b>Highlight color</b><div class="muted" style="font-size:.82rem">Buttons, links and selected things use it.</div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:8px">${HIGHLIGHTS.map(([c, n]) => `<button type="button" class="hl" data-c="${c}" title="${n}" aria-label="${n}"
        style="width:38px;height:38px;border-radius:50%;background:${c};border:3px solid ${L.accent === c ? "var(--ink)" : "transparent"};padding:0"></button>`).join("")}
        <label style="display:flex;align-items:center;gap:6px;font-size:.85rem;margin:0">Any color <input type="color" id="hlPick" value="${esc(L.accent)}" style="width:44px;height:38px;padding:0;border:0;background:none"></label></div>
    </div></div>
    <div class="card"><b>Preview</b><div class="muted" style="font-size:.85rem;margin:4px 0 10px">This is how buttons and links look now. <a href="#" onclick="return false" style="color:var(--cobalt)">A link</a></div>
      <button class="btn">📷 Guestimate something</button><button class="btn sec" style="margin-top:8px">A second button</button>
      <div class="seg"><button type="button" class="on">Selected</button><button type="button">Not selected</button></div></div>
    <div class="muted" style="font-size:.8rem;margin:0 4px 20px">Saved on this device.</div>`;
  const save = patch => { Object.assign(L, patch); setLook(L); renderLook(); };
  app.querySelectorAll("[data-seg] button").forEach(b => b.onclick = () => save({ [b.parentElement.dataset.seg]: b.dataset.v }));
  app.querySelectorAll(".hl").forEach(b => b.onclick = () => save({ accent: b.dataset.c }));
  $("#hlPick").onchange = e => save({ accent: e.target.value });
}

// ---------- Feedback ----------
const FB_STATUS = { new: ["Received", "var(--sub)"], planned: ["Planned", "var(--cobalt)"], done: ["Done ✓", "var(--green)"], declined: ["Not now", "var(--sub)"] };
async function renderFeedback(from) {
  state.view = "feedback"; setChrome(); backTo(renderHome);
  ctx.textContent = "Feedback";
  let kind = "idea";
  app.innerHTML = `<div class="card" style="border-color:var(--green)"><b>Tell us what to build or fix</b>
    <div class="muted" style="font-size:.85rem;margin:4px 0 6px">Ideas, problems, anything. It goes straight to the person who builds Guestimator, and you'll see here when it's planned or done.</div>
    <div class="seg" id="fbKind"><button type="button" data-v="idea" class="on">💡 Idea</button><button type="button" data-v="bug">🐞 Something's wrong</button><button type="button" data-v="other">💬 Other</button></div>
    <textarea id="fbMsg" rows="5" maxlength="2000" style="margin-top:10px" placeholder="e.g. Let me add a second shipping option, or: the price on my lamp didn't update"></textarea>
    <button class="btn" id="fbGo" style="margin-top:10px">Send</button></div>
    <h3 style="margin:14px 2px 6px">Your feedback</h3><div id="fbMine" class="list"><div class="muted" style="padding:10px">Loading…</div></div>`;
  $("#fbKind").querySelectorAll("button").forEach(b => b.onclick = () => { kind = b.dataset.v; $("#fbKind").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); });
  $("#fbGo").onclick = async () => {
    const message = $("#fbMsg").value.trim();
    if (message.length < 3) return toast("Tell us a bit more");
    $("#fbGo").disabled = true;
    try {
      const ver = (document.querySelector('script[src*="/app.js"]')?.src.match(/v=([^&]+)/) || [])[1] || "";
      await api("/feedback", { method: "POST", body: JSON.stringify({ kind, message, page: from || "", version: ver }) });
      toast("Thanks! Sent ✓"); renderFeedback(from);
    } catch (e) { toast(e.message); $("#fbGo").disabled = false; }
  };
  try {
    const { items } = await api("/feedback/mine");
    const el = $("#fbMine"); if (!el) return;
    el.innerHTML = items.length ? items.map(f => { const [label, color] = FB_STATUS[f.status] || FB_STATUS.new;
      return `<div class="li" style="display:block"><div class="row" style="justify-content:space-between;gap:8px"><span class="muted" style="font-size:.78rem">${esc(String(f.created_at).slice(0, 10))}</span>
        <span class="pill" style="color:${color};border-color:${color}">${esc(label)}</span></div>
        <div style="white-space:pre-wrap;margin-top:4px;font-size:.9rem">${esc(f.message)}</div>
        ${f.owner_note ? `<div style="margin-top:6px;font-size:.85rem;border-left:3px solid var(--green);padding-left:8px"><b>From us:</b> ${esc(f.owner_note)}</div>` : ""}</div>`; }).join("")
      : `<div class="muted" style="padding:10px">Nothing yet. Your first idea could be the next feature.</div>`;
  } catch (e) { const el = $("#fbMine"); if (el) el.innerHTML = `<div class="muted" style="padding:10px">${esc(e.message)}</div>`; }
}

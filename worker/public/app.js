// Guestimator — front-end (split from Bottle Tree 2026-09-27)
const $ = s => document.querySelector(s);
const app = $("#app"), tabs = $("#tabs"), ctx = $("#ctx"), backBtn = $("#backBtn"),
      cartbar = $("#cartbar");
let state = { view: "home" };
let user = null;
let billingInit = false;
let pendingPhotos = [];   // photos staged on the manual "Add an item" card
window.addEventListener("bt:plan", () => { if (state.view === "home") renderHome(); });

const money = c => "$" + (c / 100).toFixed(2);
const esc = s => (s || "").replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
async function api(path, opts) {
  const r = await fetch("/api" + path, { headers: { "content-type": "application/json" }, credentials: "same-origin", ...opts });
  if (r.status === 401 && !path.startsWith("/auth")) { user = null; renderAuth(); throw new Error("Please sign in"); }
  if (!r.ok) {
    let e = {}; try { e = await r.json(); } catch {}
    if (r.status === 402 && e.paywall && window.BTBilling) { BTBilling.refresh().then(() => BTBilling.open("You're out of credits. 1 credit = 1 estimate or 1 eBay listing. Your items and photos are saved.")); }
    // Carry the whole error body, not just its message. Callers that can actually resolve a
    // failure need the detail — which items have no price, what needs confirming — and throwing
    // a bare string turns every one of those into an unexplained red toast.
    const err = new Error(e.error || ("HTTP " + r.status));
    Object.assign(err, e);
    err.status = r.status;
    throw err;
  }
  return r.json();
}
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 1800); }
window.toast = toast;
// estimates pill (sales screen); refreshed after purchases
function planPill() {
  const p = window.BTBilling && BTBilling.plan;
  if (!p) return "";
  return `<a href="#" id="planPill" class="pill" style="text-decoration:none">${esc(BTBilling.summary())}${p.plan === "free" ? " · get more" : ""}</a>`;
}

// The tab bar is fixed to the bottom of the screen, so the page needs to end above it. The
// padding used to be a flat 76px, which is wrong on any phone with a home indicator: the bar
// itself is 6px + its buttons + 6px + env(safe-area-inset-bottom), and that overflowed the
// allowance and sat on top of the last thing on the page. On the appraisal card the last thing
// is the "Re-run appraisal" button, so the bar was covering a control nobody could reach.
//
// Measuring beats arithmetic here. Emoji line-height and the safe-area inset differ per device,
// and the cart bar floats above the tab bar only on the cashier tab, so the clearance needed
// changes as you move around the app.
function syncBottomPad() {
  // NOT offsetParent: it is null for every position:fixed element, visible or not, so using it
  // here measured both bars as absent and applied no padding at all. Height is the honest test.
  const visible = el => el && !el.classList.contains("hidden") && el.getBoundingClientRect().height > 0;
  let pad = 0;
  if (visible(tabs)) pad = tabs.getBoundingClientRect().height;
  if (visible(cartbar)) pad = Math.max(pad, window.innerHeight - cartbar.getBoundingClientRect().top);
  // A little air under the last element, and never less than the safe-area inset on its own.
  document.body.style.setProperty("--bottom-pad", pad ? `${Math.ceil(pad) + 12}px` : "calc(20px + var(--sab))");
}
addEventListener("resize", syncBottomPad);
addEventListener("orientationchange", syncBottomPad);

function setChrome() {
  tabs.classList.add("hidden");
  cartbar.classList.add("hidden");
  backBtn.classList.add("hidden");
  ctx.textContent = "";
  syncBottomPad();
}

// ---------- Sign in with Google ----------
// Two paths, one endpoint. On the web we use Google Identity Services. Inside the
// Capacitor shell GIS is unusable (Google blocks OAuth in embedded WebViews with
// disallowed_useragent), so the native build uses Credential Manager via the
// social-login plugin and hands us the same ID token.
const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
let authCfg = null, gisReady = null, gInit = false;

async function getAuthCfg() {
  if (authCfg) return authCfg;
  try { authCfg = await api("/auth/config"); } catch { authCfg = { google_client_id: null }; }
  return authCfg;
}
function loadGis() {
  if (gisReady) return gisReady;
  gisReady = new Promise((res, rej) => {
    if (window.google && google.accounts && google.accounts.id) return res();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true; s.onload = () => res(); s.onerror = () => rej(new Error("gsi load failed"));
    document.head.appendChild(s);
  });
  return gisReady;
}
async function signInWithGoogleToken(credential) {
  try {
    const r = await api("/auth/google", { method: "POST", body: JSON.stringify({ credential }) });
    user = r.email; billingInit = false; toast("Signed in"); renderHome();
  } catch (e) { toast(e.message); }
}
async function nativeGoogleSignIn(btn) {
  const cfg = await getAuthCfg();
  const SL = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.SocialLogin;
  if (!SL) return toast("Google sign-in isn't available in this build");
  btn.disabled = true;
  try {
    if (!gInit) { await SL.initialize({ google: { webClientId: cfg.google_client_id } }); gInit = true; }
    const res = await SL.login({ provider: "google", options: { scopes: ["email", "profile"] } });
    const idToken = res && res.result && res.result.idToken;
    if (!idToken) throw new Error("Google didn't return a token");
    await signInWithGoogleToken(idToken);
  } catch (e) {
    toast((e && e.message) ? e.message : "Google sign-in was cancelled");
  } finally { btn.disabled = false; }
}
async function mountGoogle() {
  const wrap = $("#gWrap"); if (!wrap) return;
  const cfg = await getAuthCfg();
  if (!cfg.google_client_id) { wrap.remove(); return; }   // not configured yet — stay password-only
  wrap.style.display = "";
  if (isNative) {
    wrap.querySelector("#gBtn").innerHTML =
      `<button class="btn" id="gNative" style="background:#fff;color:#222;border:1px solid #dadce0">Continue with Google</button>`;
    $("#gNative").onclick = () => nativeGoogleSignIn($("#gNative"));
    return;
  }
  try {
    await loadGis();
    google.accounts.id.initialize({
      client_id: cfg.google_client_id,
      callback: r => signInWithGoogleToken(r.credential),
      ux_mode: "popup"
    });
    google.accounts.id.renderButton($("#gBtn"), {
      theme: "outline", size: "large", text: "continue_with", shape: "rectangular", width: 300
    });
  } catch { wrap.remove(); }
}

// ---------- Auth ----------
function renderAuth(mode) {
  mode = mode || "login";
  state.view = "auth"; state.saleId = null; state.detail = null; setChrome();
  ctx.textContent = "";
  const isLogin = mode === "login";
  app.innerHTML = `
    <div style="text-align:center;margin:34px 0 8px">
      <div class="big" style="font-size:1.7rem">${isLogin ? "Welcome back" : "Create your account"}</div>
      <div class="muted">${isLogin ? "Sign in to your items." : "Price it from what's selling now, then list it on eBay."}</div>
    </div>
    <div class="card">
      <label>Email</label>
      <input id="auEmail" type="email" autocomplete="email" placeholder="you@example.com" enterkeyhint="next">
      <div style="height:10px"></div>
      <label>Password</label>
      <input id="auPw" type="password" autocomplete="${isLogin ? "current-password" : "new-password"}" placeholder="${isLogin ? "Your password" : "At least 8 characters"}" enterkeyhint="go">
      <div style="height:14px"></div>
      <button class="btn" id="auGo">${isLogin ? "Sign in" : "Create account"}</button>
      <div id="gWrap" style="display:none">
        <div class="muted" style="text-align:center;margin:14px 0 10px">or</div>
        <div id="gBtn" style="display:flex;justify-content:center"></div>
      </div>
    </div>
    <div class="muted" style="text-align:center">${isLogin ? "New here?" : "Already have an account?"}
      <a href="#" id="auToggle" style="color:var(--cobalt);font-weight:800">${isLogin ? "Create an account" : "Sign in"}</a></div>`;
  const go = async () => {
    const email = $("#auEmail").value.trim(), password = $("#auPw").value;
    if (!email || !password) return toast("Email and password, please");
    try {
      await api("/auth/" + (isLogin ? "login" : "register"), { method: "POST", body: JSON.stringify({ email, password }) });
      user = email; toast(isLogin ? "Signed in" : "Account created"); renderHome();
    } catch (e) { toast(e.message); }
  };
  $("#auGo").onclick = go;
  $("#auPw").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  $("#auToggle").onclick = e => { e.preventDefault(); renderAuth(isLogin ? "register" : "login"); };
  mountGoogle();
}
async function logout() {
  try { await api("/auth/logout", { method: "POST" }); } catch {}
  try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch {}
  user = null; billingInit = false; renderAuth("login");
}

// ---------- Home: what's it worth, and your items ----------
let ebayStatus = null;
async function loadEbayStatus() {
  try { ebayStatus = await api("/ebay/status"); } catch { ebayStatus = null; }
  return ebayStatus;
}
function ebayCardHtml(s) {
  if (!s || !s.configured) return "";
  if (s.connected) return `<div class="card" style="padding:12px 16px">
      <div class="row" style="justify-content:space-between;align-items:center;gap:8px">
        <div><b>eBay connected</b><div class="muted" style="font-size:.82rem">${s.username ? "as " + esc(s.username) : "Ready to list"}</div></div>
        <a href="#" id="ebayOff" class="muted" style="font-size:.8rem;font-weight:700">Disconnect</a>
      </div></div>`;
  return `<div class="card" style="border-color:var(--cobalt)">
      <label>Sell it on eBay</label>
      <div class="muted" style="font-size:.88rem;margin-bottom:10px">Guestimator writes the listing for you — title, photos, item specifics and a price from what's selling now. You check it, tap List, and it goes up on your own eBay account.</div>
      <button class="btn" id="ebayOn" style="background:var(--cobalt)">Connect my eBay account</button>
      <div class="muted" style="font-size:.82rem;margin-top:8px;text-align:center">No eBay account? <a href="${esc(s.signup_url)}" target="_blank" rel="noopener" style="color:var(--cobalt);font-weight:800">Create one free</a>, then come back and connect it.</div>
    </div>`;
}
// In the Android app (build 7+) eBay's sign-in opens in a Chrome Custom Tab over the app, and
// finishing it sends ai.banksy.bottletree://ebay/connected, which comes back here as appUrlOpen.
// Plain navigation was the old way: Android handed auth.ebay.com to the eBay app when installed,
// which just showed the account and never came back - measured 2026-09-27, no connection saved.
const capPlugin = n => (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins[n]) || null;
const inAppBrowser = () => isNative && capPlugin("Browser") && capPlugin("App");
async function connectEbay() {
  try {
    const native = !!inAppBrowser();
    const { url } = await api("/ebay/connect", { method: "POST", body: JSON.stringify({ native }) });
    toast("Opening eBay…");
    if (native) await capPlugin("Browser").open({ url });
    else location.href = url;
  } catch (e) { toast(e.message); }
}
// After eBay: refresh the status and redraw whatever screen the person is on.
async function afterEbayReturn(ok) {
  const was = ebayStatus && ebayStatus.connected;
  const now = await loadEbayStatus();
  if (ok === false) toast("eBay wasn't connected — try again");
  else if (now && now.connected) toast(was ? "eBay connected" : `eBay connected${now.username ? " as " + now.username : ""} ✓`);
  if (state.view === "home") renderHome();
  else if (state.view === "item" && state.itemId) renderItemDetail(state.itemId);
}
if (inAppBrowser()) {
  capPlugin("App").addListener("appUrlOpen", ev => {
    const u = String(ev && ev.url || "");
    if (!/^ai\.banksy\.bottletree:\/\/ebay\//.test(u)) return;
    capPlugin("Browser").close().catch(() => {});
    afterEbayReturn(!/\/failed/.test(u));
  });
}
function wireEbayCard(after) {
  if ($("#ebayOn")) $("#ebayOn").onclick = connectEbay;
  if ($("#ebayOff")) $("#ebayOff").onclick = async e => {
    e.preventDefault();
    if (!confirm("Disconnect eBay?\n\nListings already on eBay stay up. To fully remove access, also remove Guestimator in My eBay > Account > Third-party app access.")) return;
    try { await api("/ebay/connection", { method: "DELETE" }); } catch (err) { return toast(err.message); }
    toast("eBay disconnected"); after();
  };
}
// Back from anywhere else (an older app build, a manual app switch): if the eBay connection
// changed meanwhile, say so and redraw the current screen - not only the home screen.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !user || !["home", "item"].includes(state.view)) return;
  // Android freezes timers while the app is in the background, so a poll scheduled before the
  // dealer switched apps may never fire. Coming back to a screen that is waiting on an estimate
  // reloads it straight away.
  if (state.view === "item" && state.itemId && state.pendingId === state.itemId) renderItemDetail(state.itemId);
  else if (state.view === "home") renderHome();
  const was = !!(ebayStatus && ebayStatus.connected);
  const s = await loadEbayStatus();
  if (s && !!s.connected !== was) {
    toast(s.connected ? "eBay connected" : "eBay disconnected");
    if (state.view === "home") renderHome(); else if (state.itemId) renderItemDetail(state.itemId);
  }
});

async function renderHome() {
  state.view = "home"; setChrome();
  app.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:center;margin:10px 0 2px;gap:8px;flex-wrap:wrap">
      <span class="muted" style="font-size:.82rem">${esc(user || "")}</span>
      <span class="row" style="gap:10px">${planPill()}<a href="#" id="signout" class="muted" style="font-size:.82rem;font-weight:700">Sign out</a></span>
    </div>
    <div class="card" style="border-color:var(--green)">
      <h1 class="h1" style="margin:0 0 4px">What's it worth?</h1>
      <div class="muted" style="font-size:.9rem;margin-bottom:12px">Snap a few photos, say what you know, and get a price from what's listed right now — with the comparables to prove it.</div>
      <button class="btn" id="aiAdd">📷 Guestimate something</button>
    </div>
    <div id="ebayCard"></div>
    <div class="card"><div class="row" style="justify-content:space-between;align-items:center;gap:10px">
      <div><b>Garage & estate sales</b><div class="muted" style="font-size:.82rem">Free sale page, price tags, holds, online buying</div></div>
      <button class="btn sec sm" id="toSales" style="white-space:nowrap">Your sales <span id="salesBadge"></span></button></div></div>
    <div class="row" style="justify-content:space-between;margin:14px 2px 6px"><h3>Your items</h3></div>
    <div id="itemList" class="list"><div class="muted" style="padding:10px">Loading…</div></div>`;
  $("#aiAdd").onclick = () => renderCapture();
  $("#toSales").onclick = () => renderSales();
  $("#signout").onclick = e => { e.preventDefault(); logout(); };
  if ($("#planPill")) $("#planPill").onclick = e => { e.preventDefault(); BTBilling.open(); };
  if (window.BTBilling && !billingInit) { billingInit = true; BTBilling.init().then(p => { if (p && state.view === "home") renderHome(); }); }
  loadEbayStatus().then(s => { const c = $("#ebayCard"); if (c && state.view === "home") { c.innerHTML = ebayCardHtml(s); wireEbayCard(renderHome); } });
  // Hold requests and paid orders waiting on the seller, so they're seen without opening Sales.
  api("/garage/sales").then(ss => {
    const n = (ss || []).reduce((t, s) => t + (s.new_holds || 0) + (s.open_orders || 0), 0);
    const b = $("#salesBadge");
    if (b && n) { b.textContent = n; b.title = `${n} waiting on you`; b.style.cssText = "display:inline-block;min-width:20px;padding:0 6px;margin-left:4px;border-radius:10px;background:var(--rust);color:#fff;font-size:.75rem;line-height:20px;text-align:center"; }
  }).catch(() => {});
  let list = [];
  try { list = await api("/items"); } catch (e) { $("#itemList").innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }
  const el = $("#itemList");
  if (!list.length) { el.innerHTML = `<div class="empty"><div class="em">🔎</div>Nothing yet. Tap <b>Guestimate something</b> to price your first item.</div>`; return; }
  const badge = i => i.ebay_status === "published" ? `<span class="pill" style="background:var(--cobalt);color:#fff">on eBay</span>`
    : i.appraisal_status === "pending" ? `<span class="pill">estimating…</span>`
    : i.appraisal_status === "error" ? `<span class="pill" style="color:var(--rust)">needs a retry</span>`
    : i.appraisal_status === "done" ? `<span class="pill">priced</span>` : "";
  el.innerHTML = list.map(i => `<div class="li tap" data-open="${i.id}">
      ${i.thumb_key ? `<img src="/p/${esc(i.thumb_key)}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:8px">` : `<span style="width:48px;text-align:center">📦</span>`}
      <div style="min-width:0"><div class="nm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.ai_title || i.name)}</div><div style="margin-top:2px">${badge(i)}</div></div>
      <span class="pr">${i.price_cents ? money(i.price_cents) : ""}</span>
    </div>`).join("");
  el.querySelectorAll("[data-open]").forEach(li => li.onclick = () => renderItemDetail(li.dataset.open));
  // An "estimating…" badge used to sit there until the dealer pulled to refresh. Keep checking
  // while anything is still being priced.
  if (list.some(i => i.appraisal_status === "pending")) {
    clearTimeout(pollT);
    pollT = setTimeout(() => { if (state.view === "home") renderHome(); }, 6000);
  }
}

// ---------- eBay: the listing card on an item, and the review screen ----------
function ebayPanelHtml(b, canList) {
  const el = b.ebay;
  if (el && el.status === "published")
    return `<div class="card" style="border-color:var(--cobalt)"><b>Listed on eBay ✓</b>
      <div style="height:8px"></div><a class="btn" style="display:block;text-align:center;text-decoration:none;background:var(--cobalt)" href="${esc(el.listing_url || "#")}" target="_blank" rel="noopener">View on eBay ↗</a></div>`;
  if (!canList) return "";
  if (ebayStatus && !ebayStatus.configured) return "";
  return `<div class="card" style="border-color:var(--cobalt)">
      <label>Sell it</label>
      <div class="muted" style="font-size:.85rem;margin-bottom:10px">We'll write the eBay listing from this estimate — you check every word before anything goes live.</div>
      ${el && el.status === "error" ? `<div style="font-size:.82rem;color:var(--rust);margin-bottom:8px">Last try didn't go through: ${esc(el.error || "")}</div>` : ""}
      <button class="btn" id="ebayList" style="background:var(--cobalt)">List it on eBay</button>
    </div>`;
}
async function startEbayListing(id, categoryId) {
  const s = ebayStatus || await loadEbayStatus();
  if (!s || !s.configured) return toast("eBay listing isn't switched on yet");
  if (!s.connected) {
    if (confirm("First, connect your eBay account.\n\nOK to sign in to eBay now. (No account? You can create one on the next screen.)")) connectEbay();
    return;
  }
  clearTimeout(pollT);
  app.innerHTML = `<div class="card" style="text-align:center;margin-top:30px"><div class="big" style="font-size:1.3rem">Writing your eBay listing…</div>
    <div class="muted">Picking the category and filling in the item specifics. About half a minute.</div></div>`;
  try {
    const r = await api("/items/" + id + "/ebay/draft", { method: "POST", body: JSON.stringify(categoryId ? { category_id: categoryId } : {}) });
    if (r.listing && r.listing.status === "published") return renderItemDetail(id);
    renderEbayDraft(id, r.draft);
  } catch (e) { toast(e.message); renderItemDetail(id); }
}
const CONDITION_FALLBACK = [{ value: "USED_EXCELLENT", label: "Used" }, { value: "NEW", label: "New" }];
// The seller's own edits to a draft, per item. "Not yet — edit" on the fee screen and "Back to the
// estimate" used to re-render from the AI's draft and silently throw every change away.
const ebayEdits = {};
function renderEbayDraft(id, d) {
  state.view = "ebay"; setChrome();
  const e = ebayEdits[id] || null;
  // Aspects and condition belong to a category; after a category switch only the free-text
  // fields carry over.
  const sameCat = e && d.category && e.category_id === d.category.id;
  const val = {
    title: e ? e.title : d.title,
    price: e ? e.price : (d.price ? Number(d.price).toFixed(2) : ""),
    condition: sameCat && e.condition ? e.condition : d.condition,
    condition_note: e ? e.condition_note : (d.condition_note || ""),
    description: e ? e.description : d.description,
    postal_code: e && e.postal_code ? e.postal_code : ((ebayStatus && ebayStatus.postal_code) || ""),
    shipping_cost: e ? e.shipping_cost : "",
    handling_days: e ? String(e.handling_days) : "3",
  };
  const conds = d.conditions && d.conditions.length ? d.conditions : CONDITION_FALLBACK;
  const aspectRow = (s, n) => {
    const v = ((sameCat ? e.aspects[s.name] : d.aspects[s.name]) || [])[0] || "";
    const lab = `<label>${esc(s.name)}${s.required ? ` <span style="color:var(--rust)">*</span>` : ""}</label>`;
    if (s.selection_only) return `${lab}<select data-asp="${esc(s.name)}"><option value="">—</option>${s.values.map(x => `<option${x === v ? " selected" : ""}>${esc(x)}</option>`).join("")}</select><div style="height:8px"></div>`;
    return `${lab}<input data-asp="${esc(s.name)}" value="${esc(v)}" list="asp${n}" maxlength="65"><datalist id="asp${n}">${s.values.slice(0, 30).map(x => `<option value="${esc(x)}">`).join("")}</datalist><div style="height:8px"></div>`;
  };
  const credits = ebayStatus && ebayStatus.listing_credits;
  app.innerHTML = `
    <button class="back" id="dBack" style="padding:8px 0">‹ Back to the estimate</button>
    <h1 class="h1">Your eBay listing</h1>
    <div class="muted" style="font-size:.85rem">Check it over. Nothing goes to eBay until you tap List.</div>
    <div class="thumbs">${d.images.map(u => `<img src="${esc(u)}" alt="">`).join("")}</div>
    ${d.images_skipped ? `<div class="muted" style="font-size:.78rem">${d.images_skipped} photo${d.images_skipped === 1 ? "" : "s"} left out — eBay can't take that format.</div>` : ""}
    <div class="card">
      <label>Title <span class="muted" id="tCount" style="text-transform:none;letter-spacing:0"></span></label>
      <input id="eTitle" maxlength="80" value="${esc(val.title)}">
      <div style="height:8px"></div>
      <label>Price</label>
      <input id="ePrice" inputmode="decimal" value="${esc(val.price)}" placeholder="$0.00">
      ${d.price_basis ? `<div class="muted" style="font-size:.78rem;margin-top:3px">Starting from the ${esc(d.price_basis)}.</div>` : `<div style="font-size:.78rem;margin-top:3px;color:var(--rust)">The estimate didn't settle on a price — set one yourself.</div>`}
      <div style="height:8px"></div>
      <label>Category</label>
      <select id="eCat">${(d.categories || []).map(c => `<option value="${esc(c.id)}"${d.category && c.id === d.category.id ? " selected" : ""}>${esc(c.path || c.name)}</option>`).join("")}</select>
      <div style="height:8px"></div>
      ${d.condition_applies === false
        ? `<div class="muted" style="font-size:.82rem">eBay doesn't use a condition grade in this category — describe any wear in the description.</div>`
        : `<label>Condition</label>
      <select id="eCond">${conds.map(c => `<option value="${esc(c.value)}"${c.value === val.condition ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select>
      <div style="height:8px"></div>
      <label>Condition notes</label>
      <input id="eCondNote" value="${esc(val.condition_note)}" placeholder="Chips, wear, repairs — buyers read this">`}
    </div>
    <div class="card">
      <label style="margin-bottom:8px">Item specifics</label>
      ${d.aspect_spec.length ? d.aspect_spec.map(aspectRow).join("") : `<div class="muted" style="font-size:.85rem">eBay doesn't ask for any in this category.</div>`}
      ${d.missing.length ? `<div style="font-size:.8rem;color:var(--rust)">Fill in the starred ones — eBay requires them.</div>` : ""}
    </div>
    <div class="card">
      <label>Description</label>
      <textarea id="eDesc" rows="8">${esc(val.description)}</textarea>
    </div>
    <div class="card">
      <label>Shipping</label>
      <div class="row" style="gap:8px">
        <div style="flex:1"><div class="muted" style="font-size:.75rem">Ships from ZIP</div><input id="eZip" inputmode="numeric" maxlength="5" value="${esc(val.postal_code)}" placeholder="12345"></div>
        <div style="flex:1"><div class="muted" style="font-size:.75rem">Buyer pays</div><input id="eShip" inputmode="decimal" value="${esc(val.shipping_cost)}" placeholder="e.g. 12.00 (0 = free)"></div>
        <div style="flex:.7"><div class="muted" style="font-size:.75rem">Ships within</div><select id="eDays">${["1", "2", "3", "5"].map(n => `<option value="${n}"${n === val.handling_days ? " selected" : ""}>${n} day${n === "1" ? "" : "s"}</option>`).join("")}</select></div>
      </div>
      <div class="muted" style="font-size:.75rem;margin-top:6px">USPS Priority, flat rate. 30-day returns, buyer pays return shipping. Change these any time in eBay Seller Hub.</div>
    </div>
    <button class="btn" id="eGo" style="background:var(--cobalt)">Preview listing &amp; eBay fees</button>
    <div class="muted" style="font-size:.75rem;text-align:center;margin:8px 0 20px">Nothing goes live yet. Next you'll see the listing and eBay's exact fees, then decide.</div>`;
  const tc = () => $("#tCount").textContent = `(${$("#eTitle").value.length}/80)`;
  $("#eTitle").oninput = tc; tc();
  // Everything on the form, as the seller left it. category_id is the category these aspects and
  // this condition were chosen for, so a later category switch knows not to carry them over.
  const readForm = () => {
    const aspects = {};
    app.querySelectorAll("[data-asp]").forEach(x => { if (x.value.trim()) aspects[x.dataset.asp] = [x.value.trim()]; });
    return {
      title: $("#eTitle").value, price: $("#ePrice").value, category_id: d.category ? d.category.id : $("#eCat").value,
      condition: $("#eCond") ? $("#eCond").value : null, condition_note: $("#eCondNote") ? $("#eCondNote").value : "",
      aspects, description: $("#eDesc").value,
      postal_code: $("#eZip").value, shipping_cost: $("#eShip").value, handling_days: $("#eDays").value,
    };
  };
  $("#dBack").onclick = () => { ebayEdits[id] = readForm(); renderItemDetail(id); };
  $("#eCat").onchange = () => {
    if (!d.category || $("#eCat").value !== d.category.id) { ebayEdits[id] = readForm(); startEbayListing(id, $("#eCat").value); }
  };
  $("#eGo").onclick = async () => {
    const body = readForm();
    ebayEdits[id] = body;
    const aspects = body.aspects;
    const miss = d.aspect_spec.filter(s => s.required && !aspects[s.name]).map(s => s.name);
    if (miss.length) return toast("eBay requires: " + miss.join(", "));
    body.category_id = $("#eCat").value;
    if (!/^\d{5}$/.test(body.postal_code.trim())) { $("#eZip").focus(); return toast("Enter the ZIP code you ship from"); }
    if (body.shipping_cost.trim() === "" || isNaN(Number(body.shipping_cost))) { $("#eShip").focus(); return toast("What does the buyer pay for shipping? 0 for free."); }
    // Nothing goes live from this screen. Preview saves the listing on eBay UNPUBLISHED (buyers
    // can't see it, it costs nothing) and asks eBay what publishing it would cost.
    const btn = $("#eGo"); btn.disabled = true; btn.textContent = "Checking with eBay…";
    try {
      const r = await api("/items/" + id + "/ebay/preview", { method: "POST", body: JSON.stringify(body) });
      renderEbayPreview(id, d, body, r);
    } catch (e) {
      btn.disabled = false; btn.textContent = "Preview listing & eBay fees";
      if (e.needs_connect) return connectEbay();
      if (e.missing) toast("eBay requires: " + e.missing.join(", "));
      else toast(e.message);
    }
  };
}

// The last stop before money is spent: the listing as buyers will see it, eBay's own fee quote for
// it, and what it costs in Guestimator credits. Only "List it" publishes.
function renderEbayPreview(id, d, body, r) {
  state.view = "ebay"; setChrome();
  const money2 = n => "$" + Number(n || 0).toFixed(2);
  const f = r.fees;
  const cond = (d.conditions || []).find(c => c.value === body.condition);
  const shipping = Number(body.shipping_cost) === 0 ? "Free shipping" : `${money2(body.shipping_cost)} shipping (USPS Priority)`;
  const feeRows = f && f.fees.length
    ? f.fees.map(x => `<div class="split"><span>${esc(x.type.replace(/([a-z])([A-Z])/g, "$1 $2"))}${x.discount ? ` <span class="muted" style="font-size:.78rem">(−${money2(x.discount)} promo)</span>` : ""}</span><span class="amt">${money2(x.net)}</span></div>`).join("")
    : f ? `<div class="muted" style="font-size:.88rem">eBay quotes <b>no fee to list</b> this item.</div>` : "";
  app.innerHTML = `
    <button class="back" id="pBack" style="padding:8px 0">‹ Edit the listing</button>
    <h1 class="h1">Ready to list?</h1>
    <div class="muted" style="font-size:.85rem">Saved on eBay but <b>not live</b>: nobody can see it until you tap List.</div>
    <div class="card">
      ${d.images[0] ? `<img src="${esc(d.images[0])}" alt="" style="width:100%;max-height:260px;object-fit:contain;border-radius:10px;background:var(--bg)">` : ""}
      <h3 style="font-size:1.1rem;margin-top:10px">${esc(body.title)}</h3>
      <div class="big" style="font-size:1.6rem;color:var(--green)">${money2(body.price)}</div>
      <div class="muted" style="font-size:.85rem">${[cond && cond.label, shipping, `ships within ${esc(body.handling_days)} day${body.handling_days === "1" ? "" : "s"}`, "30-day returns"].filter(Boolean).join(" · ")}</div>
      <div class="muted" style="font-size:.8rem;margin-top:4px">${esc((d.categories.find(c => c.id === body.category_id) || d.category || {}).path || "")}</div>
      ${Object.keys(body.aspects).length ? `<div style="font-size:.82rem;margin-top:8px">${Object.entries(body.aspects).map(([k, v]) => `<b>${esc(k)}:</b> ${esc(v.join(", "))}`).join(" · ")}</div>` : ""}
      <details style="margin-top:8px"><summary class="muted" style="font-size:.82rem;cursor:pointer">Description</summary><div style="white-space:pre-wrap;font-size:.88rem;margin-top:6px">${esc(body.description)}</div></details>
    </div>
    <div class="card">
      <label>What eBay charges to list it</label>
      ${f ? feeRows + `<div class="split" style="font-weight:800"><span>eBay listing fees</span><span class="amt">${money2(f.total)}</span></div>`
          : `<div style="color:var(--rust);font-size:.88rem">eBay didn't return a fee quote (${esc(r.fee_error || "unknown")}). Check fees in eBay before listing.</div>`}
      ${f && f.warnings.length ? `<div class="muted" style="font-size:.78rem;margin-top:6px">${f.warnings.map(esc).join(" · ")}</div>` : ""}
      <div class="muted" style="font-size:.78rem;margin-top:8px">eBay also takes a final value fee (a percentage) only if it sells. ${r.listing_credits ? "Listing uses 1 Guestimator credit (the same credits as estimates), returned if eBay rejects it." : ""}</div>
    </div>
    <button class="btn" id="pList" style="background:var(--cobalt)">List it now${f ? ` · eBay fees ${money2(f.total)}` : ""}</button>
    <div style="height:8px"></div>
    <button class="btn sec" id="pEdit">Not yet — edit</button>
    <div style="height:20px"></div>`;
  $("#pBack").onclick = $("#pEdit").onclick = () => renderEbayDraft(id, d);
  $("#pList").onclick = async () => {
    const btn = $("#pList"); btn.disabled = true; btn.textContent = "Listing on eBay…";
    try {
      const res = await api("/items/" + id + "/ebay/publish", { method: "POST", body: JSON.stringify(body) });
      if (window.BTBilling) BTBilling.refresh();
      delete ebayEdits[id];
      app.innerHTML = `<div class="card" style="text-align:center;margin-top:30px;border-color:var(--cobalt)">
        <div class="big" style="font-size:1.4rem">It's on eBay 🎉</div>
        <div class="muted" style="margin:6px 0 14px">${esc(body.title)}</div>
        ${res.url ? `<a class="btn" style="display:block;text-decoration:none;background:var(--cobalt)" href="${esc(res.url)}" target="_blank" rel="noopener">View your listing ↗</a>` : ""}
        ${(res.warnings || []).length ? `<div class="muted" style="font-size:.78rem;margin-top:8px">eBay notes: ${res.warnings.map(esc).join(" · ")}</div>` : ""}
        <div style="height:8px"></div><button class="btn sec" id="doneHome">Back to my items</button></div>`;
      $("#doneHome").onclick = renderHome;
    } catch (e) {
      btn.disabled = false; btn.textContent = "List it now" + (f ? ` · eBay fees ${money2(f.total)}` : "");
      if (e.needs_connect) return connectEbay();
      toast(e.message + (e.refunded ? " — your credit was returned" : ""));
    }
  };
}

// ---------- In-page camera ----------
// `capture="environment"` only opens a camera on phones; on a laptop or a shop counter
// machine it just opens a file picker. This gives every platform a real viewfinder.
const canUseCamera = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);

function openCamera(title) {
  return new Promise(resolve => {
    let stream = null, facing = "environment", settled = false;
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:9999;background:#000;display:flex;flex-direction:column";
    const btn = "background:rgba(255,255,255,.14);color:#fff;border:0;border-radius:10px;padding:8px 14px;font:inherit;font-weight:700;cursor:pointer";
    ov.innerHTML = `
      <div style="flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:calc(12px + var(--sat)) 14px 12px;color:#fff">
        <button id="camX" style="${btn}">Cancel</button>
        <span style="font-weight:800;font-size:.95rem;text-align:center">${esc(title || "Take a photo")}</span>
        <button id="camFlip" style="${btn}">Flip</button>
      </div>
      <div style="flex:1 1 auto;position:relative;min-height:0">
        <video id="camV" playsinline autoplay muted style="width:100%;height:100%;object-fit:contain;background:#000"></video>
        <div id="camErr" style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;text-align:center;color:#fff;padding:28px;font-size:.95rem;line-height:1.45"></div>
      </div>
      <div style="flex:0 0 auto;display:flex;align-items:center;justify-content:center;gap:18px;padding:18px 14px calc(26px + var(--sab))">
        <button id="camShot" aria-label="Take photo" style="width:74px;height:74px;border-radius:50%;background:#fff;border:5px solid rgba(255,255,255,.45);cursor:pointer"></button>
      </div>`;
    document.body.appendChild(ov);
    const v = ov.querySelector("#camV"), err = ov.querySelector("#camErr");

    const stop = () => { try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch {} stream = null; };
    const done = f => { if (settled) return; settled = true; stop(); document.removeEventListener("keydown", onKey); ov.remove(); resolve(f); };
    const onKey = e => { if (e.key === "Escape") done(null); };
    document.addEventListener("keydown", onKey);

    const fail = msg => { err.textContent = msg; err.style.display = "flex"; ov.querySelector("#camShot").style.opacity = ".35"; };

    async function start() {
      stop(); err.style.display = "none"; ov.querySelector("#camShot").style.opacity = "1";
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1920 } },
          audio: false
        });
        v.srcObject = stream;
        await v.play().catch(() => {});
      } catch (e) {
        const n = e && e.name;
        if (n === "NotAllowedError" || n === "SecurityError")
          fail("Camera access was blocked. Allow it from the camera icon in your browser's address bar, then try again — or use “choose file” instead.");
        else if (n === "NotFoundError" || n === "OverconstrainedError")
          fail("No camera found on this device. Use “choose file” instead.");
        else if (n === "NotReadableError")
          fail("Another app is using the camera. Close it and try again.");
        else fail("Couldn't start the camera. Use “choose file” instead.");
      }
    }

    ov.querySelector("#camX").onclick = () => done(null);
    ov.querySelector("#camFlip").onclick = () => { facing = facing === "environment" ? "user" : "environment"; start(); };
    ov.querySelector("#camShot").onclick = () => {
      if (!v.videoWidth) return;
      const c = document.createElement("canvas");
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      c.toBlob(b => done(b ? new File([b], "shot-" + Date.now() + ".jpg", { type: "image/jpeg" }) : null), "image/jpeg", 0.92);
    };
    start();
  });
}

// ---------- AI capture flow ----------
const SHOTS = [
  { kind: "front", label: "Front", hint: "Whole item, straight on, good light" },
  { kind: "back", label: "Back", hint: "Reverse side" },
  { kind: "underside", label: "Underside / inside", hint: "Joinery, base, foot rim, interior" },
  { kind: "marks", label: "Marks & labels", hint: "Stamps, signatures, labels, numbers — close and sharp" },
  { kind: "detail", label: "Detail", hint: "Decoration, hardware, texture" },
  { kind: "damage", label: "Damage", hint: "Chips, repairs, wear (optional)" },
];
function renderCapture() {
  state.tab = "items"; setChrome();
  const shots = {};
  app.innerHTML = `<h1 class="h1">Add item with AI</h1>
    <div class="muted" style="font-size:.85rem;margin-bottom:6px">Take the shots you can. The marks photo matters most.</div>
    <div class="card"><div class="shots" id="shots">${SHOTS.map(s => `
      <div class="shot" data-kind="${s.kind}"><input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden>
        <div class="ph" id="ph-${s.kind}">📷</div><div class="sl">${s.label}</div><div class="sh">${s.hint}</div>
        <a href="#" class="pick" style="font-size:.64rem;color:var(--sub);text-decoration:underline">choose file</a></div>`).join("")}</div>
      <div style="height:8px"></div>
      <button class="btn sec sm" id="moreCam" style="display:none">📷 Another photo</button>
      <label class="btn sec sm" style="display:inline-block">+ More photos <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden id="moreShots"></label>
      <span class="muted" id="moreCount" style="font-size:.82rem;margin-left:8px"></span>
    </div>
    <div class="card">
      <label>Brief description</label>
      <textarea id="cDesc" rows="3" placeholder="What do you know? Where it came from, how old you think it is, condition…"></textarea>
      <div style="height:10px"></div>
      <label>Any writing, stamps or marks on it</label>
      <textarea id="cMarks" rows="2" placeholder="Copy exactly what you can read, e.g. 'Stickley', 'Made in Occupied Japan', '1847 Rogers Bros'"></textarea>
      <div style="height:12px"></div>
      <button class="btn" id="cGo">✨ Guestimate it</button>
      <div style="height:6px"></div>
      <button class="btn sec" id="cCancel">Cancel</button>
    </div>`;
  const more = [];
  const setShot = (kind, f) => {
    shots[kind] = f;
    const ph = $("#ph-" + kind); ph.innerHTML = `<img src="${URL.createObjectURL(f)}" alt="">`;
  };
  app.querySelectorAll(".shot input").forEach(inp => inp.onchange = async () => {
    const kind = inp.closest(".shot").dataset.kind, f = inp.files[0];
    inp.value = "";
    if (!f) return;
    const ok = await acceptPhoto(f, kind === "marks" ? "marks photo" : "photo");
    if (ok) setShot(kind, ok);
  });
  // Tapping a tile opens the live viewfinder where we can; "choose file" is always there as a fallback.
  app.querySelectorAll(".shot").forEach(tile => {
    const kind = tile.dataset.kind, inp = tile.querySelector("input"), s = SHOTS.find(x => x.kind === kind);
    tile.querySelector(".pick").onclick = e => { e.preventDefault(); e.stopPropagation(); inp.click(); };
    tile.onclick = async () => {
      if (!canUseCamera()) return inp.click();
      const f = await openCamera(s ? s.label + " — " + s.hint : "Take a photo");
      if (!f) return;
      const ok = await acceptPhoto(f, kind === "marks" ? "marks photo" : "photo");
      if (ok) setShot(kind, ok);
    };
  });
  const bumpMore = () => $("#moreCount").textContent = more.length ? more.length + " extra" : "";
  $("#moreShots").onchange = async e => {
    const picked = [...e.target.files]; e.target.value = "";
    for (const f of picked) { const ok = await acceptPhoto(f); if (ok) more.push(ok); }
    bumpMore();
  };
  if (canUseCamera()) {
    const mc = $("#moreCam"); mc.style.display = "inline-block"; mc.style.marginRight = "8px";
    mc.onclick = async () => {
      const f = await openCamera("Another photo"); if (!f) return;
      const ok = await acceptPhoto(f); if (ok) { more.push(ok); bumpMore(); }
    };
  }
  $("#cCancel").onclick = renderHome;
  $("#cGo").onclick = async () => {
    const files = [...Object.entries(shots).map(([k, f]) => ({ kind: k, f })), ...more.map(f => ({ kind: "other", f }))];
    if (!files.length) return toast("Take at least one photo");
    const description = $("#cDesc").value.trim(), markings = $("#cMarks").value.trim();
    // Photographs alone are not enough, and the dealer standing in front of the item knows more
    // than any camera does. Four rolls of nickels shot end-on were read as shotgun shells; the
    // words "four rolls of war nickels" would have settled it in one line.
    if (!description && !markings) {
      $("#cDesc").focus();
      $("#cDesc").style.borderColor = "var(--rust)";
      return toast("Tell us what it is, even roughly — the photo alone gets it wrong too often.");
    }
    $("#cGo").disabled = true; $("#cGo").textContent = "Uploading…";
    try {
      const { id } = await api("/items", { method: "POST", body: JSON.stringify({ name: "New item", description, markings }) });
      const fd = new FormData();
      for (const { kind, f } of files) fd.append("photos", await shrink(f), f.name || (kind + ".jpg"));
      fd.append("kinds", files.map(x => x.kind).join(","));
      const up = await fetch("/api/items/" + id + "/photos", { method: "POST", body: fd, credentials: "same-origin" });
      if (!up.ok) throw new Error((await up.json()).error || "upload failed");
      $("#cGo").textContent = "Pricing it…";
      await api("/items/" + id + "/appraise", { method: "POST", body: JSON.stringify({}) });
      renderItemDetail(id);
    } catch (e) { toast(e.message); $("#cGo").disabled = false; $("#cGo").textContent = "✨ Guestimate it"; }
  };
}
// How sharp a photo is, as the variance of its Laplacian: high where edges are crisp, near zero
// where everything is a smudge. Measured on a fixed 320px width so the number means the same
// thing for every camera.
//
// Calibrated on two real items in this account rather than a number from a blog post. Four rolls
// of nickels stood on end, photographed slightly out of focus, scored 167 and 229 — that item was
// appraised five times and identified five different ways, once as shotgun shells, once as a 2023
// Silver Eagle set that priced it at $260 when its silver alone was worth $585. A sharp photo of
// a memory kit scored 2644 and 2242 and was identified correctly every single time. An order of
// magnitude apart. BLURRY sits well clear of both, because refusing a usable photo costs a dealer
// more than accepting a marginal one.
// app.js is a classic script, not a module — no export here, or the whole file fails to parse.
const BLURRY = 300, SOFT = 700;
async function sharpness(file) {
  try {
    const bmp = await createImageBitmap(file);
    const w = 320, h = Math.max(1, Math.round(bmp.height * w / bmp.width));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(bmp, 0, 0, w, h);
    const d = c.getContext("2d").getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    let n = 0, s = 0, s2 = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const L = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      n++; s += L; s2 += L * L;
    }
    if (!n) return null;
    const mean = s / n;
    return Math.round(s2 / n - mean * mean);
  } catch { return null; }   // can't measure it — never block a photo on that
}

// Hand a blurry photo back before it is uploaded. The dealer is standing in front of the item
// with the camera in their hand; that is the only moment a retake is cheap.
async function acceptPhoto(file, what = "photo") {
  // A HEIC is converted here rather than refused, because on iOS - where HEICs come from - the
  // browser can decode it and shrink() now produces a JPEG. Only if that genuinely failed is the
  // dealer told, and then it is told as something they can act on. Refusing every HEIC on sight
  // would block photos that this device could have handled perfectly well.
  //
  // A HEIC that gets through is not a degraded appraisal, it is no appraisal at all dressed up
  // as one: the vision model reads nothing and the card comes back priced from the dealer's
  // sentence, with every line of its evidence beginning "Dealer reports".
  if (isHeic(file)) {
    const converted = await shrink(file);
    if (!isHeic(converted)) { file = converted; }
    else {
      alert(
        `That photo is in Apple's HEIC format and this browser cannot convert it, so ` +
        `Guestimator would price the item from your description alone.\n\n` +
        `On iPhone: Settings > Camera > Formats > Most Compatible. Then take the photo again.`);
      return null;
    }
  }
  const s = await sharpness(file);
  if (s === null || s >= SOFT) return file;
  if (s >= BLURRY) { toast(`That ${what} is a little soft — a sharper one reads better.`); return file; }
  const again = confirm(
    `That ${what} came out blurry.\n\n` +
    `Guestimator reads the picture, and a blurry one is where it guesses wrong — ` +
    `one out-of-focus shot here has been identified five different ways.\n\n` +
    `OK to take it again, or Cancel to use it anyway.`);
  return again ? null : file;
}

// downscale to <=1600px JPEG so uploads are quick on cell data
// The HEIC early-return that used to be on the next line was the whole bug. It refused to even
// attempt a HEIC - and iOS Safari, the one browser a HEIC actually arrives from, decodes HEIC
// natively. So on the device where the problem exists, the fix was one line away and we were
// declining to take it. On a browser that genuinely cannot decode HEIC the createImageBitmap
// below throws and the catch returns the file untouched, which is exactly the old behaviour.
//
// isHeic() is therefore a question about the OUTPUT, never the input: did this actually come out
// as a JPEG? That is the only version of the question worth asking, because the answer differs
// by browser and guessing it from the file name is how this got missed.
function isHeic(file) {
  return /heic|heif/i.test(file && file.type || "") || /\.hei[cf]$/i.test(file && file.name || "");
}

async function shrink(file, max = 1600) {
  if (!file.type.startsWith("image/") && !isHeic(file)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    // A small JPEG needs nothing doing to it. A small HEIC still has to be re-encoded, because
    // the point is the format and not the size - returning it here is how a 2MB iPhone photo
    // would have slipped through the fix.
    if (s === 1 && file.size < 2.5e6 && !isHeic(file)) return file;
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.86));
    return new File([blob], (file.name || "photo").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch { return file; }
}
// ---------- Item detail: photos, appraisal card, approve & list ----------
let pollT;
async function renderItemDetail(id) {
  clearTimeout(pollT);
  state.tab = "items"; setChrome();
  let b;
  try { b = await api("/items/" + id); } catch (e) {
    // One failed check (a phone dropping signal for a second) used to end polling for good and
    // leave "Appraising…" on screen long after the result was saved. Keep trying while the
    // estimate is still outstanding.
    if (state.pendingId === id)
      pollT = setTimeout(() => { if (state.view === "item" && state.itemId === id) renderItemDetail(id); }, 6000);
    return toast(e.message);
  }
  const { item, photos, appraisal } = b;
  const r = appraisal && appraisal.result;
  const pending = appraisal && appraisal.status === "pending";
  state.pendingId = pending ? id : null;
  const pr = r && r.price_range;
  const conf = r ? Math.round(r.confidence * 100) : 0;
  // When the identification is contested there is no headline number, so there is nothing to
  // anchor on and nothing to pre-fill into the price box either.
  const nc = r && r.needs_clarification;
  app.innerHTML = `
    <button class="back" id="toItems" style="padding:8px 0">‹ My items</button>
    <div class="thumbs">${photos.map(p => `<img src="${esc(p.url)}" alt="${esc(p.kind)}" title="${esc(p.kind)}">`).join("")}</div>
    ${pending ? `<div class="card" style="text-align:center"><div class="big" style="font-size:1.3rem">Guestimating…</div><div class="muted">Nemotron is reading ${photos.length} photo${photos.length === 1 ? "" : "s"}. Usually under a minute.</div></div>` : ""}
    ${appraisal && appraisal.status === "error" ? `<div class="card" style="border-color:var(--rust)"><b>The guestimate didn't go through.</b><div class="muted" style="font-size:.85rem">${esc(appraisal.error)}</div><div style="height:8px"></div><button class="btn sec sm" id="retry">Try again</button></div>` : ""}
    ${r ? `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:flex-start"><h3 style="font-size:1.15rem">${esc(r.identification.name)}</h3><span class="pill" title="confidence">${conf}% sure</span></div>
      <div class="muted" style="font-size:.85rem">${[r.identification.maker, r.identification.period, r.identification.origin, r.identification.style].filter(Boolean).map(esc).join(" · ")}</div>
      ${nc ? `<div style="margin:12px 0;padding:10px 12px;border:1px solid var(--rust);border-radius:10px;background:var(--bg)">
          <b style="font-size:.95rem">No price yet — ${esc(nc.reason)}.</b>
          ${nc.candidates ? `<div style="margin-top:6px;font-size:.85rem">Those are different items at different prices, so a number here would be a guess dressed up as an estimate. <b>Which is it?</b>
            <div class="seg" style="margin-top:6px">${nc.candidates.map((c, n) =>
              `<button type="button" data-pick="${n}">${esc(c.length > 52 ? c.slice(0, 50) + "…" : c)}</button>`).join("")}</div>
            <div class="muted" style="margin-top:4px;font-size:.78rem">One tap settles it — or answer below instead.</div>
          </div>` : ""}
          ${(nc.questions && nc.questions.length ? nc.questions : [{ q: nc.question, options: [] }]).map((it, n) => `
            <div style="margin-top:8px;font-size:.85rem"><b>${esc(it.q)}</b></div>
            ${it.options && it.options.length
              ? `<div class="seg" data-ans="${n}">${it.options.map(o => `<button type="button" data-opt="${esc(o)}">${esc(o)}</button>`).join("")}</div>`
              : `<input id="clarify${n}" style="margin-top:4px" placeholder="${n === 0 ? "A few words is enough" : "Optional"}">`}`).join("")}
          <div style="height:8px"></div>
          <button class="btn sm" id="clarifyGo">Answer &amp; price it</button>
          ${r.melt && r.melt.applied ? `<div class="muted" style="margin-top:8px;font-size:.8rem">What we do know: it holds <b>$${r.melt.value}</b> of ${esc(r.melt.metal)} at today's spot — but that figure assumes the identification too.</div>` : ""}
        </div>`
      : `<div class="kpis" style="margin:12px 0">
        <div class="kpi"><div class="n">$${Math.round(pr.low)}–$${Math.round(pr.high)}</div><div class="l">Price range</div></div>
        <div class="kpi"><div class="n">$${Math.round(pr.suggested_retail)}</div><div class="l">Suggested · floor $${Math.round(pr.floor)}</div></div>
      </div>`}
      ${r.lot ? `<div style="margin:8px 0;padding:8px 10px;border-left:3px solid var(--amber,#b8860b);background:var(--bg);font-size:.82rem">
          <b>$${r.lot.unit_retail} each × ${r.lot.count} pieces</b> — $${r.lot.unit_low}–$${r.lot.unit_high} per piece
          <div class="muted" style="margin-top:3px">Counted because ${esc(r.lot.how)}. The totals above are the whole lot; sold one at a time the per-piece price is what matters — check that it looks right.</div>
        </div>` : ""}
      ${r.market ? `<div style="margin:8px 0;padding:8px 10px;border-left:3px solid var(--cobalt);background:var(--bg);font-size:.82rem">
          ${r.market.count === 1
            ? `<b>1 comparable listed on eBay right now</b> — <b>$${r.market.low}</b>`
            : `<b>${r.market.count} comparable${r.market.count === 1 ? "" : "s"} listed on eBay right now</b> — $${r.market.low}–$${r.market.high}, median <b>$${r.market.median}</b>`}
          ${r.market.split ? `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--line)">
            <b>Two different markets here</b>, ${r.market.split.ratio}× apart:
            <div style="margin-top:3px">${r.market.split.lower.count} at $${r.market.split.lower.low}–$${r.market.split.lower.high} (median $${r.market.split.lower.median})</div>
            <div>${r.market.split.upper.count} at $${r.market.split.upper.low}–$${r.market.split.upper.high} (median $${r.market.split.upper.median})</div>
            <div class="muted" style="margin-top:3px">Usually a rarer pattern, colour or variant. If yours is the dearer kind, say so in the description and re-run — the range above averages across both.</div>
          </div>` : ""}
          <div class="muted" style="margin-top:3px">Asking prices, not sold prices, so they run high. Checked ${esc(String(r.market.as_of).slice(0, 10))}.${r.market_all ? ` eBay returned ${r.market_all.count} listings in all ($${r.market_all.low}–$${r.market_all.high}); the rest were judged different items — see “Set aside” below.` : ""}</div>
          ${(r.live_listings || []).length ? `<div style="margin-top:5px">${r.live_listings.map(l =>
            `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><a href="${esc(l.url)}" target="_blank" rel="noopener" style="color:var(--cobalt)">$${Math.round(l.price)}${l.condition ? ` · ${esc(l.condition)}` : ""} — ${esc(l.title)}</a></div>`).join("")}</div>` : ""}
        </div>` : ""}
      ${r.melt ? `<div style="margin:8px 0;padding:8px 10px;border-left:3px solid var(--green);background:var(--bg);font-size:.82rem">
          <b>Metal content:</b> ${r.melt.fine_troy_oz} ozt ${esc(r.melt.metal)} × $${r.melt.price_per_oz.toFixed(2)}/ozt = <b>$${r.melt.value} melt</b>
          <div class="muted" style="margin-top:3px">${esc(r.melt.basis)}</div>
          <div class="muted" style="margin-top:3px;font-size:.92em">${esc(r.melt.source)}, ${esc(String(r.melt.as_of).slice(0, 10))}. ${r.melt.applied === false ? "Weight is an estimate, so this has <b>not</b> been used as a price floor — weigh it to be sure." : "Scrap is a floor — never sell below it."}</div>
        </div>` : ""}
      <div class="muted" style="font-size:.82rem">${esc(pr.basis)}</div>
      ${r.evidence.length ? `<h3 style="font-size:.95rem;margin-top:12px">Why</h3><ul class="ev">${r.evidence.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
      ${r.transcribed_text.length ? `<div class="muted" style="font-size:.82rem;margin-top:6px">Read on item: ${r.transcribed_text.map(esc).join(" · ")}</div>` : ""}
      ${r.comparables.length ? `<h3 style="font-size:.95rem;margin-top:12px">Comparables</h3>${r.comparables.map(c => `<div class="split"><a href="${esc(c.url)}" target="_blank" rel="noopener" style="color:var(--cobalt)">${esc(c.title)}</a><span class="amt">${c.price ? "$" + Math.round(c.price) : ""}</span></div>`).join("")}` : ""}
      ${(r.rejected_comparables || []).length ? `<details style="margin-top:8px"><summary class="muted" style="font-size:.8rem;cursor:pointer">Set aside (${r.rejected_comparables.length}) — listings not used for this price</summary>${r.rejected_comparables.map(c => `<div class="muted" style="font-size:.78rem;margin-top:4px">${esc(c.title)}${c.why ? ` — <i>${esc(c.why)}</i>` : ""}</div>`).join("")}</details>` : ""}
      ${r.questions_for_dealer.length ? `<div class="muted" style="font-size:.82rem;margin-top:10px">Would help: ${r.questions_for_dealer.map(esc).join(" · ")}</div>` : ""}
      ${r.warnings.length ? `<div class="muted" style="font-size:.75rem;margin-top:8px">${r.warnings.map(esc).join(" · ")}</div>` : ""}
      <div class="muted" style="font-size:.72rem;margin-top:8px">${esc(r.models.text)} + ${esc(r.models.vision)} on Nebius</div>
    </div>` : ""}
    ${ebayPanelHtml(b, !!(r && !nc && appraisal.status === "done"))}
    ${r && !nc && appraisal.status === "done" ? salePanelHtml() : ""}
    <div class="row" style="gap:8px;margin-bottom:16px;flex-wrap:wrap">
      ${!pending && photos.length ? `<button class="btn sec sm" id="reappraise">↻ Re-run the estimate</button>` : ""}
      <button class="btn sec sm" id="delItem" style="color:var(--rust)">Delete item</button>
    </div>
`;
  $("#toItems").onclick = () => { clearTimeout(pollT); renderHome(); };
  if ($("#ebayList")) $("#ebayList").onclick = () => startEbayListing(id);
  if ($("#toSale")) $("#toSale").onclick = () => { clearTimeout(pollT); addItemToSale(id); };
  $("#delItem").onclick = async () => {
    const onEbay = b.ebay && b.ebay.status === "published";
    const msg = onEbay
      ? "Delete this item from Guestimator?\n\nIt is LIVE on eBay. Deleting it here does NOT end the eBay listing. If you no longer want to sell it, end the listing in eBay too."
      : "Delete this item and its photos? This can't be undone.";
    if (!confirm(msg)) return;
    clearTimeout(pollT);
    try { await api("/items/" + id, { method: "DELETE" }); } catch (e) { return toast(e.message); }
    toast("Deleted"); renderHome();
  };
  if (!ebayStatus) loadEbayStatus();
  // Re-running must NOT post the form's description. That box holds the LISTING copy — the
  // shop-page prose the model wrote — and the appraise endpoint reads `description` as the
  // dealer's own account of the item. Posting one as the other overwrote "These are 4 rolls of
  // world war 2 silver nickels" with "A 2023 Jefferson nickel struck by the United States
  // Mint...", and every later run was then anchored to the model's own previous guess. A lot
  // holding $584 of silver came back at $1.42. It is also self-confirming: the gates that are
  // supposed to catch a bad identification all compare against the dealer's words, and those
  // words had been replaced by the identification. Re-run sends nothing and keeps what the
  // dealer wrote.
  const rerun = async (extra) => {
    try { await api("/items/" + id + "/appraise", { method: "POST", body: JSON.stringify(extra || {}) }); }
    catch (e) {
      // The appraiser will not run on photographs alone. Put the cursor where the answer goes
      // rather than just refusing.
      if (e.needs_description) { const d = $("#lDesc") || $("#iDesc"); if (d) { d.focus(); d.scrollIntoView({ block: "center" }); } }
      return toast(e.message);
    }
    renderItemDetail(id);
  };
  // Re-run goes back to the photos-and-details step, not straight to the model: by now the dealer
  // has seen what it was taken for and which listings it was compared with, and that is exactly
  // when they know what to add — a sharper marks photo, "it's the cobalt one", a size.
  if ($("#reappraise")) $("#reappraise").onclick = () => { clearTimeout(pollT); renderRefine(id, b); };
  // The answer is appended to the DEALER's stored description — item.description — not to the
  // listing box on this form, which holds the model's prose. Appending to that box would feed
  // the model's own words back as the dealer's.
  // A tap on a candidate is the fastest way out of a contested identification: the dealer is
  // holding the object and already knows which of the two it is.
  const answerWith = async (text, btn) => {
    if (btn) { btn.disabled = true; btn.textContent = "Pricing…"; }
    await rerun({ dealer_description: [String(item.description || "").trim(), text].filter(Boolean).join(". ") });
  };
  app.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => {
    const pick = (nc && nc.candidates || [])[+b.dataset.pick];
    if (!pick) return;
    // One of the two candidates IS the dealer's own description, so picking it adds nothing —
    // appending it produced "These are 4 rolls of world war 2 silver nickels. It is These are 4
    // rolls of world war 2 silver nickels". Confirming what you already said just re-runs; only
    // choosing the model's reading is new information.
    const have = String(item.description || "").toLowerCase();
    const said = pick.toLowerCase().trim();
    answerWith(have.includes(said) ? "" : `It is ${pick}`, b);
  });
  // Otherwise each question the model asked gets its own line, and the answers go back as the
  // dealer's own words, paired with the question so they read as statements later.
  // Chips are a single-choice group: tapping one deselects its siblings. Nothing is sent until
  // "Answer & price it", so a mis-tap costs nothing and the dealer can answer all three first.
  app.querySelectorAll("[data-ans] [data-opt]").forEach(b => b.onclick = () => {
    const on = b.classList.contains("on");
    b.parentElement.querySelectorAll("[data-opt]").forEach(x => x.classList.remove("on"));
    if (!on) b.classList.add("on");
  });
  if ($("#clarifyGo")) $("#clarifyGo").onclick = async () => {
    const qs = (nc.questions && nc.questions.length ? nc.questions : [{ q: nc.question, options: [] }]);
    const answered = qs.map((it, n) => {
      const chip = app.querySelector(`[data-ans="${n}"] [data-opt].on`);
      const v = chip ? chip.dataset.opt : (($("#clarify" + n) || {}).value || "").trim();
      return v ? `${String(it.q).replace(/\?+$/, "")}: ${v}` : null;
    }).filter(Boolean);
    if (!answered.length) {
      const f = $("#clarify0"); if (f) f.focus();
      return toast("Tap an answer, or type a few words.");
    }
    await answerWith(answered.join(". "), $("#clarifyGo"));
  };
  if ($("#retry")) $("#retry").onclick = () => rerun();
  state.view = "item"; state.itemId = id;
  if (pending) pollT = setTimeout(() => { if (state.view === "item") renderItemDetail(id); }, 4000);
}

// ---------- Refine & re-run: back to photos + details, with what the last estimate found ----------
// The questions the model asked and the listings it compared against are shown here because they
// are the prompt: "it took this for a Silver Eagle set" is what tells the dealer to say "rolls of
// war nickels". Answers go back as the DEALER's words (item.description), never the listing copy.
function renderRefine(id, b) {
  const { item, photos, appraisal } = b;
  const r = appraisal && appraisal.result;
  const qs = (r && r.questions_for_dealer) || [];
  const comps = r ? (r.comparables || []).slice(0, 4) : [];
  const room = Math.max(0, 12 - photos.length);
  app.innerHTML = `
    <button class="back" id="rfBack" style="padding:8px 0">‹ Back to the estimate</button>
    <h1 class="h1">Add details &amp; re-run</h1>
    ${r ? `<div class="card" style="font-size:.88rem">
      <div class="muted" style="font-size:.78rem">Last time it was read as</div>
      <b>${esc(r.identification.name)}</b>${r.price_range && !r.needs_clarification ? ` <span class="muted">· $${Math.round(r.price_range.low)}–$${Math.round(r.price_range.high)}</span>` : ""}
      ${comps.length ? `<div class="muted" style="font-size:.78rem;margin-top:8px">Compared with</div>${comps.map(c =>
        `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:.82rem"><a href="${esc(c.url)}" target="_blank" rel="noopener" style="color:var(--cobalt)">${c.price ? "$" + Math.round(c.price) + " — " : ""}${esc(c.title)}</a></div>`).join("")}` : ""}
      <div class="muted" style="font-size:.78rem;margin-top:8px">Wrong item, wrong version, or yours is better or worse than these? Say so below — that's what moves the price.</div>
    </div>` : ""}
    ${qs.length ? `<div class="card"><label>It asked</label>${qs.map((q, n) => `
      <div style="margin-top:8px;font-size:.88rem"><b>${esc(q)}</b></div>
      <input id="rfQ${n}" placeholder="Skip if you don't know">`).join("")}</div>` : ""}
    <div class="card">
      <label>Photos (${photos.length} so far)</label>
      <div class="thumbs" style="margin:6px 0">${photos.map(p => `<img src="${esc(p.url)}" alt="${esc(p.kind)}" title="${esc(p.kind)}">`).join("")}</div>
      ${room ? `<div class="muted" style="font-size:.82rem;margin-bottom:6px">Add a sharper or closer shot — marks and labels help most. Up to ${room} more.</div>
      <div class="shots" id="rfShots">${SHOTS.map(s => `
        <div class="shot" data-kind="${s.kind}"><input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden>
          <div class="ph" id="rfph-${s.kind}">📷</div><div class="sl">${s.label}</div><div class="sh">${s.hint}</div>
          <a href="#" class="pick" style="font-size:.64rem;color:var(--sub);text-decoration:underline">choose file</a></div>`).join("")}</div>
      <div style="height:8px"></div>
      <label class="btn sec sm" style="display:inline-block">+ More photos <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden id="rfMore"></label>
      <span class="muted" id="rfCount" style="font-size:.82rem;margin-left:8px"></span>`
      : `<div class="muted" style="font-size:.82rem">This item already has the maximum of 12 photos.</div>`}
    </div>
    <div class="card">
      <label>What you know about it</label>
      <textarea id="rfDesc" rows="3" placeholder="What it is, where it came from, age, condition…">${esc(item.description || "")}</textarea>
      <div style="height:10px"></div>
      <label>Any writing, stamps or marks on it</label>
      <textarea id="rfMarks" rows="2" placeholder="Copy exactly what you can read">${esc(item.markings || "")}</textarea>
      <div style="height:12px"></div>
      <button class="btn" id="rfGo">✨ Re-run the estimate</button>
      <div class="muted" style="font-size:.78rem;margin-top:6px;text-align:center">Uses 1 credit, same as the first estimate.</div>
      <div style="height:6px"></div>
      <button class="btn sec" id="rfCancel">Cancel</button>
    </div>`;
  const shots = {}, more = [];
  const count = () => Object.keys(shots).length + more.length;
  const bump = () => { const c = $("#rfCount"); if (c) c.textContent = count() ? count() + " new" : ""; };
  const full = () => { if (count() >= room) { toast(`That's the 12-photo limit for one item.`); return true; } return false; };
  const setShot = (kind, f) => { if (!shots[kind] && full()) return; shots[kind] = f; $("#rfph-" + kind).innerHTML = `<img src="${URL.createObjectURL(f)}" alt="">`; bump(); };
  app.querySelectorAll("#rfShots .shot input").forEach(inp => inp.onchange = async () => {
    const kind = inp.closest(".shot").dataset.kind, f = inp.files[0];
    inp.value = "";
    if (!f) return;
    const ok = await acceptPhoto(f, kind === "marks" ? "marks photo" : "photo");
    if (ok) setShot(kind, ok);
  });
  app.querySelectorAll("#rfShots .shot").forEach(tile => {
    const kind = tile.dataset.kind, inp = tile.querySelector("input"), s = SHOTS.find(x => x.kind === kind);
    tile.querySelector(".pick").onclick = e => { e.preventDefault(); e.stopPropagation(); inp.click(); };
    tile.onclick = async () => {
      if (!canUseCamera()) return inp.click();
      const f = await openCamera(s ? s.label + " — " + s.hint : "Take a photo");
      if (!f) return;
      const ok = await acceptPhoto(f, kind === "marks" ? "marks photo" : "photo");
      if (ok) setShot(kind, ok);
    };
  });
  if ($("#rfMore")) $("#rfMore").onchange = async e => {
    const picked = [...e.target.files]; e.target.value = "";
    for (const f of picked) { if (full()) break; const ok = await acceptPhoto(f); if (ok) more.push(ok); }
    bump();
  };
  const back = () => renderItemDetail(id);
  $("#rfBack").onclick = back; $("#rfCancel").onclick = back;
  $("#rfGo").onclick = async () => {
    const answers = qs.map((q, n) => {
      const v = (($("#rfQ" + n) || {}).value || "").trim();
      return v ? `${String(q).replace(/\?+$/, "")}: ${v}` : null;
    }).filter(Boolean);
    const desc = [$("#rfDesc").value.trim(), ...answers].filter(Boolean).join(". ");
    const markings = $("#rfMarks").value.trim();
    if (!desc && !markings) {
      $("#rfDesc").focus(); $("#rfDesc").style.borderColor = "var(--rust)";
      return toast("Tell us what it is, even roughly — the photo alone gets it wrong too often.");
    }
    const files = [...Object.entries(shots).map(([k, f]) => ({ kind: k, f })), ...more.map(f => ({ kind: "other", f }))];
    const go = $("#rfGo"); go.disabled = true;
    let uploaded = false;
    try {
      if (files.length) {
        go.textContent = "Uploading…";
        const fd = new FormData();
        for (const { kind, f } of files) fd.append("photos", await shrink(f), f.name || (kind + ".jpg"));
        fd.append("kinds", files.map(x => x.kind).join(","));
        const up = await fetch("/api/items/" + id + "/photos", { method: "POST", body: fd, credentials: "same-origin" });
        if (!up.ok) throw new Error((await up.json().catch(() => ({}))).error || "upload failed");
        uploaded = true;
      }
      go.textContent = "Pricing it…";
      // Only send what changed, so an untouched field never overwrites the stored one.
      const body = {};
      if (desc !== String(item.description || "").trim()) body.dealer_description = desc;
      if (markings !== String(item.markings || "").trim()) body.markings = markings;
      await api("/items/" + id + "/appraise", { method: "POST", body: JSON.stringify(body) });
      renderItemDetail(id);
    } catch (e) {
      toast(e.message);
      // Photos that did upload are kept on the item, so a retry must not send them twice.
      // If the upload itself failed they are still staged here and go with the retry.
      if (uploaded) {
        Object.keys(shots).forEach(k => { delete shots[k]; const ph = $("#rfph-" + k); if (ph) ph.textContent = "📷"; });
        more.length = 0; bump();
      }
      go.disabled = false; go.textContent = "✨ Re-run the estimate";
    }
  };
  state.view = "refine"; state.itemId = id;
}

// ---------- Photo viewer: tap a thumbnail to see it full screen, pinch / scroll / double-tap to zoom ----------
// A dealer checks a signature or a hallmark on these, so 64px squares are not enough. Delegated
// on the document so every .thumbs strip (item page, refine step) gets it without wiring.
document.addEventListener("click", e => {
  const img = e.target.closest && e.target.closest(".thumbs img");
  if (!img) return;
  const all = [...img.parentElement.querySelectorAll("img")];
  openViewer(all.map(i => ({ src: i.currentSrc || i.src, label: i.title || i.alt || "" })), all.indexOf(img));
});
function openViewer(list, start) {
  let i = Math.max(0, start), s = 1, tx = 0, ty = 0, base = null, pushed = false;
  const box = document.createElement("div");
  box.className = "lb"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "Photo viewer");
  box.innerHTML = `<img alt="" draggable="false">
    <button class="x" aria-label="Close">✕</button>
    ${list.length > 1 ? `<button class="pv" aria-label="Previous photo">‹</button><button class="nx" aria-label="Next photo">›</button>` : ""}
    <button class="zb" aria-label="Zoom">＋</button>
    <div class="cap"></div>`;
  document.body.appendChild(box);
  const im = box.querySelector("img"), cap = box.querySelector(".cap"), zb = box.querySelector(".zb");
  const apply = () => {
    im.style.transform = `translate(${tx}px,${ty}px) scale(${s})`;
    zb.textContent = s > 1.01 ? "Fit" : "＋";
  };
  // Keep the picture over the middle of the screen so it can't be flung out of sight.
  const clamp = () => {
    if (!base) return;
    const W = innerWidth, H = innerHeight, w = base.width * s, h = base.height * s;
    tx = Math.min(W / 2 - base.left, Math.max(W / 2 - base.left - w, tx));
    ty = Math.min(H / 2 - base.top, Math.max(H / 2 - base.top - h, ty));
    if (s <= 1.001) { s = 1; tx = 0; ty = 0; }
  };
  const zoomAt = (ns, cx, cy) => {
    ns = Math.min(6, Math.max(1, ns));
    if (!base) return;
    const lx = (cx - base.left - tx) / s, ly = (cy - base.top - ty) / s;
    s = ns; tx = cx - base.left - lx * s; ty = cy - base.top - ly * s;
    clamp(); apply();
  };
  const measure = () => { const t = im.style.transform; im.style.transform = "none"; base = im.getBoundingClientRect(); im.style.transform = t; };
  const show = n => {
    i = (n + list.length) % list.length; s = 1; tx = 0; ty = 0; base = null; apply();
    im.onload = measure; im.src = list[i].src;
    if (im.complete && im.naturalWidth) measure();
    cap.textContent = `${list[i].label ? list[i].label + " · " : ""}${list.length > 1 ? `${i + 1} of ${list.length} · ` : ""}pinch, scroll or double-tap to zoom`;
  };
  const close = () => {
    removeEventListener("keydown", onKey); removeEventListener("resize", onResize); removeEventListener("popstate", onPop);
    box.remove();
    if (pushed) { pushed = false; history.back(); }
  };
  // Android's back button should close the viewer, not leave the page.
  const onPop = () => { pushed = false; close(); };
  try { history.pushState({ lb: 1 }, ""); pushed = true; addEventListener("popstate", onPop); } catch { /* not fatal */ }
  const onKey = e => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight" && list.length > 1) show(i + 1);
    else if (e.key === "ArrowLeft" && list.length > 1) show(i - 1);
    else if (e.key === "+" || e.key === "=") zoomAt(s * 1.5, innerWidth / 2, innerHeight / 2);
    else if (e.key === "-") zoomAt(s / 1.5, innerWidth / 2, innerHeight / 2);
  };
  const onResize = () => { s = 1; tx = 0; ty = 0; apply(); measure(); };
  addEventListener("keydown", onKey); addEventListener("resize", onResize);
  box.querySelector(".x").onclick = e => { e.stopPropagation(); close(); };
  if (list.length > 1) {
    box.querySelector(".pv").onclick = e => { e.stopPropagation(); show(i - 1); };
    box.querySelector(".nx").onclick = e => { e.stopPropagation(); show(i + 1); };
  }
  zb.onclick = e => { e.stopPropagation(); s > 1.01 ? (s = 1, tx = 0, ty = 0, apply()) : zoomAt(2.5, innerWidth / 2, innerHeight / 2); };
  box.addEventListener("wheel", e => { e.preventDefault(); zoomAt(s * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
  // Pointer gestures: one finger pans (or swipes to the next photo when not zoomed), two pinch.
  const pts = new Map();
  let start0 = null, pinch = null, lastTap = 0;
  box.addEventListener("pointerdown", e => {
    if (e.target.closest("button")) return;
    box.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) start0 = { x: e.clientX, y: e.clientY, tx, ty, t: Date.now(), onImg: e.target === im };
    if (pts.size === 2) {
      const [a, b2] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b2.x, a.y - b2.y) || 1, s0: s };
      start0 = null;
    }
    im.classList.add("drag");
  });
  box.addEventListener("pointermove", e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && pinch) {
      const [a, b2] = [...pts.values()];
      zoomAt(pinch.s0 * Math.hypot(a.x - b2.x, a.y - b2.y) / pinch.d, (a.x + b2.x) / 2, (a.y + b2.y) / 2);
    } else if (pts.size === 1 && start0 && s > 1) {
      tx = start0.tx + e.clientX - start0.x; ty = start0.ty + e.clientY - start0.y; clamp(); apply();
    }
  });
  const up = e => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    // Lifting one finger of a pinch hands over to a pan with the other, never counted as a tap.
    if (pts.size === 1) { const r = [...pts.values()][0]; start0 = { x: r.x, y: r.y, tx, ty, t: 0, onImg: true }; }
    if (pts.size) return;
    im.classList.remove("drag");
    if (!start0) return;
    const dx = e.clientX - start0.x, dy = e.clientY - start0.y, dt = Date.now() - start0.t;
    const tap = Math.abs(dx) < 8 && Math.abs(dy) < 8 && dt < 300;
    if (tap) {
      const now = Date.now();
      if (now - lastTap < 320) { lastTap = 0; s > 1.01 ? (s = 1, tx = 0, ty = 0, apply()) : zoomAt(2.5, e.clientX, e.clientY); }
      else { lastTap = now; if (!start0.onImg && s <= 1.01) setTimeout(() => { if (lastTap === now) close(); }, 330); }
    } else if (s <= 1.01 && list.length > 1 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      show(dx < 0 ? i + 1 : i - 1);
    }
    start0 = null;
  };
  box.addEventListener("pointerup", up); box.addEventListener("pointercancel", up);
  show(i);
}

// PWA
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

// boot: check session, then show your items or the sign-in screen
(async function init() {
  try {
    const me = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (me.ok) {
      const d = await me.json(); user = d.email;
      // Back from eBay's sign-in in a browser tab: the callback redirected to /?ebay=connected.
      const fromEbay = new URLSearchParams(location.search).get("ebay") === "connected";
      if (fromEbay) history.replaceState(null, "", "/");
      if (!(await afterStripeReturn())) await renderHome();
      if (fromEbay) afterEbayReturn(true);
    }
    else renderAuth("login");
  } catch { renderAuth("login"); }
})();

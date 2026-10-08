// Guestimator — front-end (split from Bottle Tree 2026-09-27)
const $ = s => document.querySelector(s);
// First touch: remember where this visitor came from (ad, post, site) for 90 days, so sign-ups can
// be counted by source on the owner page. Only a source name and campaign, nothing personal.
(function rememberSource() {
  try {
    if (/(?:^|;\s*)gs_src=/.test(document.cookie)) return;
    const q = new URLSearchParams(location.search);
    let s = q.get("utm_source"), c = q.get("utm_campaign") || "";
    if (!s && document.referrer) { try { const h = new URL(document.referrer).hostname; if (h && h !== location.hostname) s = h.replace(/^www\./, ""); } catch {} }
    if (!s) return;
    document.cookie = "gs_src=" + encodeURIComponent((s + "|" + c).slice(0, 80)) + ";path=/;max-age=7776000;samesite=lax;secure";
  } catch {}
})();
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
let gisInited = false;
const botStart = {};   // item id -> when its robot animation started (see renderItemDetail)
// iPhone, iPod, and iPad (which reports itself as a Mac with a touch screen).
const appleTouch = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
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
    user = r.email; billingInit = false; toast("Signed in"); await afterSignIn(); renderHome();
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
    // iPhone/iPad Safari: Google's popup opens as a new tab and comes back "400. That's an
    // error" (Derek's iPad, 2026-10-05), so there the whole page goes to Google and Google posts
    // the sign-in back to /api/auth/google/redirect - once that URI is authorized (google_redirect).
    if (!gisInited) {
      google.accounts.id.initialize(cfg.google_redirect && appleTouch()
        ? { client_id: cfg.google_client_id, ux_mode: "redirect", login_uri: location.origin + "/api/auth/google/redirect" }
        : { client_id: cfg.google_client_id, callback: r => signInWithGoogleToken(r.credential), ux_mode: "popup" });
      gisInited = true;
    }
    google.accounts.id.renderButton($("#gBtn"), {
      theme: "outline", size: "large", text: "continue_with", shape: "rectangular", width: 300
    });
  } catch { wrap.remove(); }
}

// ---------- Auth ----------
// ---------- onboarding: a first visit sees what Guestimator does and the sign-up form; a share
// link with ?code=XYZ is remembered and applied right after sign-in ----------
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
(function grabCode() {
  const q = new URLSearchParams(location.search), c = q.get("code"), r = q.get("ref");
  if (q.has("shared")) { state.pendingShare = true; history.replaceState(null, "", "/" + location.hash); }
  if (c && /^[A-Za-z0-9_-]{3,32}$/.test(c)) lsSet("gs_code", c.toUpperCase());
  if (r && /^[A-Za-z0-9]{4,12}$/.test(r)) lsSet("gs_ref", r.toUpperCase());
})();
const firstAuthMode = () => (lsGet("gs_had_account") ? "login" : "register");
async function afterSignIn() {
  lsSet("gs_had_account", "1");
  const ref = lsGet("gs_ref");
  if (ref) {   // a friend's invite: only counts for a new account (the server checks)
    lsSet("gs_ref", null);
    try { await api("/referral/claim", { method: "POST", body: JSON.stringify({ code: ref }) }); toast("Invite accepted ✓ Free credits arrive after your first purchase."); } catch {}
  }
  const code = lsGet("gs_code"); if (!code) return;
  lsSet("gs_code", null);
  try { const r = await api("/me/redeem", { method: "POST", body: JSON.stringify({ code }) }); toast(`Code ${code} applied: ${r.credits_added} free credits ✓`); }
  catch (e) { toast(`Code ${code}: ${e.message}`); }
}
const PITCH_STEPS = [["📷", "Snap a few photos", "Front, back, labels, maker's marks"], ["💲", "Get a Guestimate", "Priced from what's actually selling now"], ["🛒", "List it on eBay", "On your own account. You check it first"]];
// The config (with the demo link) loads lazily, so on a first visit the pitch draws before it arrives;
// renderAuth fills #demoLink again once getAuthCfg() resolves.
const demoLinkHtml = () => authCfg && authCfg.demo_video ? `<a href="${esc(authCfg.demo_video)}" target="_blank" rel="noopener" style="display:block;margin-top:10px;font-weight:800;font-size:.9rem;color:var(--cobalt);text-decoration:none">▶ Watch how it works (30 seconds)</a>` : "";
const freeCreditsLine = n => `${Number(n) || 0} free credit${Number(n) === 1 ? "" : "s"}`;
const pitchHtml = () => `<div class="card" style="padding:14px 16px">
  ${PITCH_STEPS.map(([i, t, d]) => `<div class="row" style="gap:12px;align-items:center;margin:6px 0"><div style="font-size:1.5rem;width:32px;text-align:center">${i}</div><div><b>${t}</b><div class="muted" style="font-size:.85rem">${d}</div></div></div>`).join("")}
  <div style="margin-top:10px;padding:8px 10px;border-radius:10px;background:var(--bg);font-size:.9rem">🎁 <b>Start with ${freeCreditsLine((authCfg && authCfg.signup_credits) || 5)}.</b> No card needed. Rate an estimate and get another free credit.</div>
  <div id="demoLink">${demoLinkHtml()}</div>
  <div class="muted" style="font-size:.8rem;margin-top:10px;border-top:1px solid var(--line, #e0d2b4);padding-top:8px"><b>Free:</b> garage &amp; estate sale pages, QR price tags, online checkout for your buyers, and discounted shipping labels. After that, estimates and eBay listings use credits.</div></div>`;

function renderAuth(mode) {
  mode = mode || firstAuthMode();
  state.view = "auth"; state.saleId = null; state.detail = null; setChrome();
  ctx.textContent = "";
  const isLogin = mode === "login";
  app.innerHTML = `
    <div style="text-align:center;margin:34px 0 8px">
      <div class="big" style="font-size:1.7rem">${isLogin ? "Welcome back" : "What's it worth? Sell it."}</div>
      <div class="muted">${isLogin ? "Sign in to your items." : "Price anything from what's selling now, then list it on eBay in minutes."}</div>
    </div>
    ${isLogin ? "" : pitchHtml()}
    ${lsGet("gs_ref") && !isLogin ? `<div class="card" style="padding:10px 14px;border-color:var(--green);font-size:.88rem">🎁 A friend invited you. You both get free credits after your first purchase.</div>` : ""}
    ${lsGet("gs_code") ? `<div class="card" style="padding:10px 14px;border-color:var(--cobalt);font-size:.88rem">🎁 Code <b>${esc(lsGet("gs_code"))}</b> will be applied when you ${isLogin ? "sign in" : "create your account"}.</div>` : ""}
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
      user = email; toast(isLogin ? "Signed in" : "Account created"); await afterSignIn(); renderHome();
    } catch (e) { toast(e.message); }
  };
  $("#auGo").onclick = go;
  $("#auPw").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  $("#auToggle").onclick = e => { e.preventDefault(); renderAuth(isLogin ? "register" : "login"); };
  getAuthCfg().then(() => { const d = document.getElementById("demoLink"); if (d) d.innerHTML = demoLinkHtml(); }).catch(() => {});
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
        <div><b>eBay connected</b><div class="muted" style="font-size:.82rem">${s.username ? "as " + esc(s.username) : "Ready to list"} · <a href="#" id="ebayOff" class="muted" style="font-weight:700">Disconnect</a></div></div>
        <button class="btn sec sm" id="toEbayOrders" style="white-space:nowrap">eBay sales <span id="ebayBadge"></span></button>
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
  if ($("#toEbayOrders")) { $("#toEbayOrders").onclick = () => renderEbayOrders(); ebayOrdersBadge($("#ebayBadge")); }
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

// Photos shared into the app from the phone (manifest share_target -> sw.js -> "gs-share" cache).
async function takeShared() {
  if (state.nativeShare) { const s = state.nativeShare; state.nativeShare = null; return s; }   // Android app share
  const out = { files: [], text: "" };
  try {
    const c = await caches.open("gs-share");
    for (const req of await c.keys()) {
      const r = await c.match(req);
      if (req.url.endsWith("/shared/text")) out.text = await r.text();
      else { const b = await r.blob(); out.files.push(new File([b], decodeURIComponent(r.headers.get("x-name") || "photo.jpg"), { type: b.type || "image/jpeg" })); }
      await c.delete(req);
    }
  } catch {}
  return out;
}
// Android app (Capacitor): "Share -> Guestimator" arrives through @capgo/capacitor-share-target.
// The plugin copies each photo into the app's cache; the WebView serves it at convertFileSrc(path).
(function nativeShareTarget() {
  const C = window.Capacitor, P = C && C.Plugins && C.Plugins.CapacitorShareTarget;
  if (!P || !P.addListener) return;
  P.addListener("shareReceived", async ev => {
    const files = [];
    for (const f of (ev && ev.files) || []) {
      if (!/^image\//.test(f.mimeType || "image/")) continue;
      try { const b = await (await fetch(C.convertFileSrc(f.uri))).blob(); files.push(new File([b], f.name || "photo.jpg", { type: f.mimeType || b.type || "image/jpeg" })); }
      catch (e) { console.log("shared photo unreadable", f.uri, e); }
    }
    if (!files.length) { toast("Couldn't open the shared photo. Add it from Guestimate something instead."); return; }
    state.nativeShare = { files: files.slice(0, 8), text: [ev.title, ...(ev.texts || [])].filter(Boolean).join(" ").trim().slice(0, 500) };
    state.pendingShare = true;
    if (user) renderHome();   // signed out: picked up right after sign-in
  });
})();
async function renderHome() {
  if (state.pendingShare) {
    state.pendingShare = false;
    const s = await takeShared();
    if (s.files.length) { toast(`${s.files.length} photo${s.files.length === 1 ? "" : "s"} added`); return renderCapture(s); }
  }
  state.view = "home"; setChrome();
  app.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:center;margin:10px 0 2px;gap:8px;flex-wrap:wrap">
      <span class="muted" style="font-size:.82rem">${esc(user || "")}</span>
      <span class="row" style="gap:10px">${planPill()}<a href="#" id="toFeedback" class="muted" style="font-size:.82rem;font-weight:700">💬 Feedback</a><a href="#" id="toLook" class="muted" style="font-size:.82rem;font-weight:700" title="Light, dark, black & white">🎨 Look</a><a href="#" id="signout" class="muted" style="font-size:.82rem;font-weight:700">Sign out</a></span>
    </div>
    <div class="card" style="border-color:var(--green)">
      <h1 class="h1" style="margin:0 0 4px">What's it worth?</h1>
      <div class="muted" style="font-size:.9rem;margin-bottom:12px">Snap a few photos, say what you know, and get a price from what's listed right now — with the comparables to prove it.</div>
      <button class="btn" id="aiAdd">📷 Guestimate something</button>
      <button class="btn sec" id="bulkAdd" style="margin-top:8px">🏠 Lots of items at once</button>
    </div>
    <div id="startCard"></div>
    <div id="inviteCard"></div>
    <div id="ebayCard"></div>
    <div class="card"><div class="row" style="justify-content:space-between;align-items:center;gap:10px">
      <div><b>Sales & your shop</b><div class="muted" style="font-size:.82rem">Garage sale pages, plus your own shop on the <a href="/market" target="_blank" rel="noopener" style="color:var(--cobalt)">Guestimator Market</a> (no cut taken)</div></div>
      <button class="btn sec sm" id="toSales" style="white-space:nowrap">Your sales <span id="salesBadge"></span></button></div></div>
    <div class="card" style="padding:12px 16px"><div class="row" style="justify-content:space-between;align-items:center;gap:10px">
      <div><b>Profit &amp; inventory</b><div class="muted" style="font-size:.82rem">What you've made, and what's still on the shelf</div></div>
      <div class="row" style="gap:6px"><a class="btn sec sm" href="/prices" target="_blank" rel="noopener" style="white-space:nowrap;text-decoration:none" title="What things are actually worth: the public price guide">📈 Prices</a>${state.owner ? `<a class="btn sec sm" href="/owner" target="_blank" rel="noopener" style="white-space:nowrap;text-decoration:none" title="Owner dashboard">📊 Owner</a>` : ""}<a class="btn sec sm" href="/stickers" target="_blank" rel="noopener" style="white-space:nowrap;text-decoration:none" title="A small label for each unsold item: code, name, price and a QR that opens it here">🏷 Stickers</a>
      <button class="btn sec sm" id="toProfit" style="white-space:nowrap">Report</button></div></div></div>
    <div class="row" style="justify-content:space-between;margin:14px 2px 6px"><h3>Your items</h3></div>
    <div id="itemList" class="list"><div class="muted" style="padding:10px">Loading…</div></div>`;
  $("#aiAdd").onclick = () => renderCapture();
  $("#bulkAdd").onclick = () => renderBulk();
  $("#toSales").onclick = () => renderSales();
  $("#toProfit").onclick = () => renderProfit();
  $("#signout").onclick = e => { e.preventDefault(); logout(); };
  $("#toLook").onclick = e => { e.preventDefault(); renderLook(); };
  $("#toFeedback").onclick = e => { e.preventDefault(); renderFeedback("home"); };
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
  startCard(list); inviteCard();
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

// ---------- invite a friend: personal referral link with copy / share ----------
async function inviteCard() {
  const box = $("#inviteCard");
  if (!box || lsGet("gs_invite_hidden")) return;
  let r; try { r = await api("/referral"); } catch { return; }
  if (state.view !== "home" || !r.credits) return;
  box.innerHTML = `<div class="card" style="padding:12px 16px">
    <div class="row" style="justify-content:space-between;align-items:center"><b>🎁 Give ${r.credits}, get ${r.credits}</b><a href="#" data-iv="hide" class="muted" style="font-size:.78rem">Hide</a></div>
    <div class="muted" style="font-size:.82rem;margin:4px 0 8px">Invite a friend who sells stuff. When they make their first purchase, you both get ${r.credits} free credits.${r.joined ? ` ${r.joined} joined · ${r.rewarded} rewarded.` : ""}</div>
    <div class="row" style="gap:6px"><input value="${esc(r.link)}" readonly style="flex:1;font-size:.8rem" data-iv="link"><button class="btn sec sm" data-iv="share" style="white-space:nowrap">${navigator.share ? "Share" : "Copy"}</button></div></div>`;
  box.querySelector("[data-iv=hide]").onclick = e => { e.preventDefault(); lsSet("gs_invite_hidden", "1"); box.innerHTML = ""; };
  box.querySelector("[data-iv=link]").onclick = e => e.target.select();
  box.querySelector("[data-iv=share]").onclick = async () => {
    const text = `I use Guestimator to price stuff and list it on eBay. Sign up with my link and we both get ${r.credits} free credits:`;
    if (navigator.share) { try { await navigator.share({ title: "Guestimator", text, url: r.link }); } catch {} return; }
    try { await navigator.clipboard.writeText(r.link); toast("Link copied ✓"); } catch { box.querySelector("[data-iv=link]").select(); toast("Copy the link above"); }
  };
}

// ---------- first-run checklist: the three steps to a first eBay sale, until done or hidden ----------
async function startCard(list) {
  const box = $("#startCard");
  if (!box || lsGet("gs_start_hidden")) return;
  const es = ebayStatus || await loadEbayStatus();
  const steps = [
    { done: list.some(i => i.appraisal_status === "done"), t: "Guestimate your first item", d: "Uses 1 credit. <a href=\"#\" data-st=\"credits\">Get credits or enter a code</a>", go: "capture", btn: "Start" },
    { done: !!(es && es.connected), t: "Connect your eBay account", d: "Listings go up on your own account.", go: "ebay", btn: "Connect", hide: !(es && es.configured) },
    { done: list.some(i => i.ebay_status === "published"), t: "List it on eBay", d: "Open a priced item and tap <b>List it on eBay</b>. You check every word first.", go: null },
  ].filter(s => !s.hide);
  const left = steps.filter(s => !s.done).length;
  if (!left) { box.innerHTML = ""; return; }
  if (state.view !== "home") return;
  box.innerHTML = `<div class="card" style="border-color:var(--green);padding:12px 16px">
    <div class="row" style="justify-content:space-between;align-items:center"><b>Get your first sale</b><a href="#" data-st="hide" class="muted" style="font-size:.78rem">Hide</a></div>
    ${steps.map((s, n) => `<div class="row" style="gap:10px;align-items:center;margin:8px 0;${s.done ? "opacity:.6" : ""}">
      <div style="width:24px;height:24px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:800;${s.done ? "background:var(--green);color:#fff" : "border:2px solid var(--green)"}">${s.done ? "✓" : n + 1}</div>
      <div style="flex:1;min-width:0"><div style="font-weight:700;${s.done ? "text-decoration:line-through" : ""}">${s.t}</div>${s.done ? "" : `<div class="muted" style="font-size:.8rem">${s.d}</div>`}</div>
      ${!s.done && s.go ? `<button class="btn sec sm" data-st="${s.go}" style="white-space:nowrap">${s.btn}</button>` : ""}</div>`).join("")}
    <div class="muted" style="font-size:.78rem;margin-top:4px">Selling in person instead? <a href="#" data-st="sales" style="font-weight:700">Start a free garage sale page</a></div></div>`;
  box.querySelectorAll("[data-st]").forEach(x => x.onclick = e => {
    e.preventDefault();
    const k = x.dataset.st;
    if (k === "hide") { lsSet("gs_start_hidden", "1"); box.innerHTML = ""; }
    else if (k === "capture") renderCapture();
    else if (k === "credits") { if (window.BTBilling) BTBilling.open(); }
    else if (k === "sales") renderSales();
    else if (k === "ebay") { const b = $("#ebayOn"); if (b) b.click(); else toast("Use the eBay card below to connect"); }
  });
}

// ---------- eBay: the listing card on an item, and the review screen ----------
// Price and offers for a live listing, changed from here. Editing the price on eBay itself fails
// while auto-accept sits at or above the new price; changing it here moves the offer limits too.
const usd = c => "$" + (Number(c || 0) / 100).toFixed(2);
function listingControlsHtml(el) {
  if (!el.id || !el.price_cents) return "";
  const on = el.best_offer_accept_cents != null;
  return `<div class="row" style="gap:8px;align-items:center;margin-top:10px">
      <span style="font-size:.9rem">Price</span>
      <input id="elPrice" inputmode="decimal" value="${(el.price_cents / 100).toFixed(2)}" style="flex:1;min-width:0">
      <button class="btn sec" id="elPriceGo" style="width:auto;padding:10px 14px">Change price</button></div>
    <label class="row" style="gap:8px;align-items:flex-start;margin-top:10px;font-weight:600;text-transform:none;letter-spacing:0;font-size:.9rem;color:inherit"><input type="checkbox" id="elOffers" ${on ? "checked" : ""} style="width:auto;margin-top:3px">
      <span>Accept offers<div class="muted" style="font-size:.75rem;font-weight:400">${on
        ? `On: offers of ${usd(el.best_offer_accept_cents)} or more are accepted automatically${el.best_offer_decline_cents ? `, under ${usd(el.best_offer_decline_cents)} declined` : ""}. Untick to sell only at your price.`
        : "Off: buyers pay your price. Tick to let buyers make offers (90% or more of your price accepted automatically)."}</div></span></label>`;
}
function bindListingControls(id, el) {
  if (!el || !$("#elPriceGo")) return;
  $("#elPriceGo").onclick = async () => {
    const v = Number(String($("#elPrice").value).replace(/[$,\s]/g, ""));
    if (!(v >= 0.99)) { $("#elPrice").focus(); return toast("Enter a price of at least $0.99"); }
    const btn = $("#elPriceGo"); btn.disabled = true; btn.textContent = "Updating eBay…";
    try { const r = await api(`/ebay/listings/${encodeURIComponent(el.id)}/price`, { method: "POST", body: JSON.stringify({ price_cents: Math.round(v * 100) }) });
      toast(r.unchanged ? "That's already the price" : `Price changed on eBay to ${usd(r.price_cents)} ✓`); renderItemDetail(id); }
    catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "Change price"; }
  };
  $("#elOffers").onchange = async () => {
    const box = $("#elOffers"), on = box.checked; box.disabled = true;
    try { await api(`/ebay/listings/${encodeURIComponent(el.id)}/best-offer`, { method: "POST", body: JSON.stringify({ enabled: on }) });
      toast(on ? "Offers turned on ✓" : "Offers turned off — buyers pay your price ✓"); renderItemDetail(id); }
    catch (e) { toast(e.message); box.checked = !on; box.disabled = false; }
  };
}
function ebayPanelHtml(b, canList) {
  const el = b.ebay;
  if (el && el.status === "published")
    return `<div class="card" style="border-color:var(--cobalt)"><b>Listed on eBay ✓</b>${listingControlsHtml(el)}
      <div style="height:8px"></div><a class="btn" style="display:block;text-align:center;text-decoration:none;background:var(--cobalt)" href="${esc(el.listing_url || "#")}" target="_blank" rel="noopener">View on eBay ↗</a><div id="guideBox" style="margin-top:10px;font-size:.82rem"></div><div id="etsyBox"></div></div>`;
  if (!canList) return "";
  if (ebayStatus && !ebayStatus.configured) return "";
  return `<div class="card" style="border-color:var(--cobalt)">
      <label>Sell it</label>
      <div class="muted" style="font-size:.85rem;margin-bottom:10px">${b.appraisal ? "We'll write the eBay listing from this estimate — you check every word before anything goes live." : "We'll set it up on eBay from your title, description and photos — you set the price and check everything before it goes live."}</div>
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
    shipping_service: e && e.shipping_service === "priority" ? "priority" : "ground",
    handling_days: e ? String(e.handling_days) : "3",
    best_offer: e ? e.best_offer === true : false,   // off unless the seller ticks it (2026-10-05)
    return_policy_id: e ? e.return_policy_id || "" : "",
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
      <div style="margin-top:8px"><div class="muted" style="font-size:.75rem">Ship by</div>
        <select id="eSvc"><option value="ground"${val.shipping_service === "ground" ? " selected" : ""}>USPS Ground Advantage — cheaper, 2–5 days</option>
          <option value="priority"${val.shipping_service === "priority" ? " selected" : ""}>USPS Priority Mail — faster, 1–3 days</option></select></div>
      <div id="eShipEst">${d.shipping ? eShipEst(d.shipping) : `<div style="margin-top:8px">${sizeBtnHtml("ebay")}</div>`}</div>
      <div style="margin-top:8px"><div class="muted" style="font-size:.75rem">Returns</div>
        <select id="eRet"><option value="">Loading your eBay return policies…</option></select></div>
      <div class="muted" style="font-size:.75rem;margin-top:6px">One flat price by the USPS service above. Change these any time in eBay Seller Hub.</div>
    </div>
    <div class="card">
      <label class="row" style="gap:8px;align-items:flex-start;font-weight:600;text-transform:none;letter-spacing:0;font-size:.9rem;color:inherit"><input type="checkbox" id="eOffers" ${val.best_offer ? "checked" : ""} style="width:auto;margin-top:3px">
        <span>Accept offers<div class="muted" style="font-size:.75rem;font-weight:400">Offers at 90% of your price or more are accepted automatically; lowball offers (under 70%, or under the estimate's floor) are declined for you. Everything in between waits for you.</div></span></label>
    </div>
    <button class="btn" id="eGo" style="background:var(--cobalt)">Preview listing &amp; eBay fees</button>
    <div class="muted" style="font-size:.75rem;text-align:center;margin:8px 0 20px">Nothing goes live yet. Next you'll see the listing and eBay's exact fees, then decide.</div>`;
  // The seller's own return policies, each with what it means to a buyer, plus a new 30-day one.
  // The listing uses exactly the one chosen here, and the preview says which.
  api("/ebay/return-policies").then(rp => {
    const sel = $("#eRet"); if (!sel) return;
    // 30-day returns by default (Derek, 2026-10-01): the seller's own 30-day policy if they have
    // one, otherwise a new one. Any other policy is one tap away in the list.
    const own30 = rp.policies.find(x => /^30-day returns/.test(x.summary));
    const want = val.return_policy_id || (own30 ? own30.id : rp.new30);
    const has30 = !!own30;
    sel.innerHTML = rp.policies.map(x => `<option value="${esc(x.id)}"${x.id === want ? " selected" : ""}>${esc(x.summary)} (${esc(x.name)})</option>`).join("")
      + (has30 ? "" : `<option value="${esc(rp.new30)}"${want === rp.new30 ? " selected" : ""}>30-day returns, buyer pays return shipping (new policy)</option>`);
  }).catch(() => { const sel = $("#eRet"); if (sel) sel.innerHTML = `<option value="">Your eBay return policy</option>`; });
  const tc = () => $("#tCount").textContent = `(${$("#eTitle").value.length}/80)`;
  $("#eTitle").oninput = tc; tc();
  const bindQuote = () => { if ($("#eQuote")) $("#eQuote").onclick = () => getShipQuote(id, $("#eZip").value, $("#eQuote"), $("#eQuoteOut"), $("#eShip"), $("#eSvc").value); };
  bindQuote();
  const eSize = app.querySelector('[data-size="ebay"]');
  if (eSize) eSize.onclick = async () => { const s = await sizeIt(id, eSize); if (s) { $("#eShipEst").innerHTML = eShipEst(s); bindQuote(); } };
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
      shipping_service: $("#eSvc").value, best_offer: $("#eOffers") ? $("#eOffers").checked : false,
      return_policy_id: $("#eRet") ? $("#eRet").value : "",
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
  const svcName = body.shipping_service === "priority" ? "USPS Priority Mail" : "USPS Ground Advantage";
  const shipping = Number(body.shipping_cost) === 0 ? `Free shipping (${svcName})` : `${money2(body.shipping_cost)} shipping (${svcName})`;
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
      <div class="muted" style="font-size:.85rem">${[cond && cond.label, shipping, `ships within ${esc(body.handling_days)} day${body.handling_days === "1" ? "" : "s"}`, r.returns ? esc(r.returns) : ""].filter(Boolean).join(" · ")}</div>
      <div class="muted" style="font-size:.8rem;margin-top:4px">${esc((d.categories.find(c => c.id === body.category_id) || d.category || {}).path || "")}</div>
      <div style="font-size:.82rem;margin-top:6px">${r.best_offer ? `Offers on: <b>${money2(r.best_offer.accept_cents / 100)}</b> or more accepted automatically${r.best_offer.decline_cents ? `, under <b>${money2(r.best_offer.decline_cents / 100)}</b> declined` : ""}.` : `<span class="muted">Offers off: buyers pay the listed price.</span>`}</div>
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

// ---------- optional size and weight ----------
// A 5-foot cabinet was priced against 19-inch tabletop ones, and given a 392 lb shipping weight,
// because nobody had told the model how big or heavy it was (2026-10-07). Optional W x H x D in
// inches and a weight in pounds, written into the description as plain sentences ("Size: 59 x 56 x
// 29 inches. Weight: 80 lb.") that the estimate reads and the dealer can see and edit.
const SIZE_IN_DESC = /\s*Size: [\d.]+ x [\d.]+(?: x [\d.]+)? inches\.?/;
const WEIGHT_IN_DESC = /\s*Weight: [\d.]+ lb\.?/;
function splitSize(desc) {
  const s = String(desc || ""), m = s.match(/Size: ([\d.]+) x ([\d.]+)(?: x ([\d.]+))? inches/), w = s.match(/Weight: ([\d.]+) lb/);
  return { text: s.replace(SIZE_IN_DESC, "").replace(WEIGHT_IN_DESC, "").trim(),
           dims: [m ? m[1] : "", m ? m[2] : "", m ? m[3] || "" : "", w ? w[1] : ""] };
}
const sizeBoxHtml = (p, v = []) => `<div style="height:10px"></div>
      <label>Size and weight <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">(optional, helps a lot with furniture and big pieces)</span></label>
      <div style="display:flex;gap:6px">${[["W", "Width", "in"], ["H", "Height", "in"], ["D", "Depth", "in"], ["Lb", "Weight", "lb"]].map(([k, ph, u], i) =>
        `<div style="flex:1;min-width:0"><input id="${p}${k}" inputmode="decimal" placeholder="${ph}" aria-label="${ph} (${u})" value="${esc(v[i] || "")}" style="width:100%"><div class="muted" style="font-size:.7rem;text-align:center;margin-top:2px">${ph} (${u})</div></div>`).join("")}</div>`;
const num = (p, k) => parseFloat((($("#" + p + k) || {}).value || "").replace(",", "."));
function withSize(desc, p) {
  const d = ["W", "H", "D"].map(k => num(p, k)).filter(n => n > 0 && n < 1000);
  const lb = num(p, "Lb");
  const parts = [];
  if (d.length >= 2) parts.push(`Size: ${d.map(n => +n.toFixed(1)).join(" x ")} inches.`);
  if (lb > 0 && lb < 5000) parts.push(`Weight: ${+lb.toFixed(1)} lb.`);
  const base = String(desc || "").replace(SIZE_IN_DESC, "").replace(WEIGHT_IN_DESC, "").trim();
  if (!parts.length) return base;
  return (base ? base.replace(/[.\s]*$/, "") + ". " : "") + parts.join(" ");
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
function renderCapture(pre) {
  state.tab = "items"; setChrome();
  const shots = {};
  app.innerHTML = `<button class="back" id="cBack" style="padding:8px 0">‹ Back</button>
    <h1 class="h1">Add item with AI</h1>
    <div class="muted" style="font-size:.85rem;margin-bottom:6px">Take the shots you can. The marks photo matters most.</div>
    <div class="card"><div class="shots" id="shots">${SHOTS.map(s => `
      <div class="shot" data-kind="${s.kind}"><input type="file" class="upin" accept="image/jpeg,image/png,image/webp" hidden><input type="file" class="camin" accept="image/jpeg,image/png,image/webp" capture="environment" hidden>
        <div class="ph" id="ph-${s.kind}">📷</div><div class="sl">${s.label}</div><div class="sh">${s.hint}</div>
        <div class="shotbtns"><button type="button" class="cam">Camera</button><button type="button" class="pick">Upload</button></div></div>`).join("")}</div>
      <div style="height:8px"></div>
      <button class="btn sec sm" id="moreCam" style="display:none">📷 Another photo</button>
      <label class="btn sec sm" style="display:inline-block">+ More photos <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden id="moreShots"></label>
      <span class="muted" id="moreCount" style="font-size:.82rem;margin-left:8px"></span>
    </div>
    <div class="card">
      <label>What is it?</label>
      <input id="cTitle" maxlength="80" placeholder="e.g. Oak two-door cabinet">
      <div style="height:10px"></div>
      <label>Brief description</label>
      <textarea id="cDesc" rows="3" placeholder="What do you know? Where it came from, how old you think it is, condition…"></textarea>
      ${sizeBoxHtml("cSz")}
      <div style="height:10px"></div>
      <label>Any writing, stamps or marks on it</label>
      <textarea id="cMarks" rows="2" placeholder="Copy exactly what you can read, e.g. 'Stickley', 'Made in Occupied Japan', '1847 Rogers Bros'"></textarea>
      <div style="height:12px"></div>
      <button class="btn" id="cGo">✨ Guestimate it</button>
      <div style="height:6px"></div>
      <button class="btn sec" id="cSkip">Add without a Guestimate</button>
      <div class="muted" style="font-size:.78rem;margin:4px 0 6px">Already know your price? Add it and list it on eBay or the Guestimator Market yourself. No credit used. You can still Guestimate it later.</div>
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
  app.querySelectorAll(".shot").forEach(tile => {
    const kind = tile.dataset.kind, inp = tile.querySelector(".upin"), s = SHOTS.find(x => x.kind === kind);
    // Two direct buttons: Camera takes a picture, Upload picks an existing one.
    tile.querySelector(".pick").onclick = e => { e.preventDefault(); e.stopPropagation(); inp.click(); };
    tile.querySelector(".ph").onclick = () => tile.querySelector(".cam").click(); // tapping the picture spot = Camera
    tile.querySelector(".cam").onclick = async e => {
      e.preventDefault(); e.stopPropagation();
      if (!canUseCamera()) return tile.querySelector(".camin").click();
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
  // Shared in from the gallery: first photo is the front, the rest go in as extras.
  if (pre && pre.files && pre.files.length) (async () => {
    for (const [n, f] of pre.files.entries()) {
      const ok = await acceptPhoto(f); if (!ok) continue;
      if (n === 0) setShot(SHOTS[0].kind, ok); else more.push(ok);
    }
    bumpMore();
    if (pre.text && !$("#cDesc").value) $("#cDesc").value = pre.text;
  })();
  // Back / Cancel: changed their mind. Nothing is saved until a button below is tapped, so this
  // only asks first when there is something on the screen to lose.
  const leave = () => {
    const typed = ["#cTitle", "#cDesc", "#cMarks"].some(s => $(s) && $(s).value.trim());
    if ((Object.keys(shots).length || more.length || typed) && !confirm("Leave without adding this item? Your photos and notes won't be kept.")) return;
    renderHome();
  };
  $("#cCancel").onclick = leave;
  $("#cBack").onclick = leave;
  $("#cSkip").onclick = async () => {
    const files = [...Object.entries(shots).map(([k, f]) => ({ kind: k, f })), ...more.map(f => ({ kind: "other", f }))];
    const name = $("#cTitle").value.trim();
    if (!name) { $("#cTitle").focus(); $("#cTitle").style.borderColor = "var(--rust)"; return toast("Give it a name - that's the listing title"); }
    if (!files.length) return toast("Take at least one photo - buyers need to see it");
    const btn = $("#cSkip"); btn.disabled = true; btn.textContent = "Uploading…";
    try {
      const { id } = await api("/items", { method: "POST", body: JSON.stringify({ name, description: withSize($("#cDesc").value.trim(), "cSz"), markings: $("#cMarks").value.trim() }) });
      const fd = new FormData();
      for (const { kind, f } of files) fd.append("photos", await shrink(f), f.name || (kind + ".jpg"));
      fd.append("kinds", files.map(x => x.kind).join(","));
      const up = await fetch("/api/items/" + id + "/photos", { method: "POST", body: fd, credentials: "same-origin" });
      if (!up.ok) throw new Error((await up.json()).error || "upload failed");
      renderItemDetail(id);
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "Add without a Guestimate"; }
  };
  $("#cGo").onclick = async () => {
    const files = [...Object.entries(shots).map(([k, f]) => ({ kind: k, f })), ...more.map(f => ({ kind: "other", f }))];
    if (!files.length) return toast("Take at least one photo");
    const description = withSize($("#cDesc").value.trim(), "cSz"), markings = $("#cMarks").value.trim();
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
      const { id } = await api("/items", { method: "POST", body: JSON.stringify({ name: $("#cTitle").value.trim() || "New item", description, markings }) });
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
    ${pending ? `<div class="card" style="text-align:center"><canvas id="guessBot" width="160" height="90" role="img" aria-label="A little robot checks the item with a magnifying glass, researches prices on a computer, then boxes up and ships the items" style="width:100%;max-width:480px;aspect-ratio:16/9;image-rendering:pixelated;border-radius:10px;display:block;margin:0 auto 10px"></canvas><div class="big" style="font-size:1.3rem">Guestimating…</div><div class="muted">Nemotron, our AI, is reading ${photos.length} photo${photos.length === 1 ? "" : "s"} and researching what items like yours sold for. This usually takes 1 to 2 minutes.</div></div>` : ""}
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
          <button class="btn sm" id="clarifyGo">Answer &amp; price it (free)</button>
          ${!nc.candidates && pr && pr.high > 0 ? `<button class="btn sec sm" id="acceptGuess" style="margin-left:6px">Show the price anyway</button>
            <div class="muted" style="margin-top:6px;font-size:.78rem">Free. Unmarked pieces often can't be pinned to a maker — the price comes from similar items selling now.</div>` : ""}
          ${r.melt && r.melt.applied ? `<div class="muted" style="margin-top:8px;font-size:.8rem">What we do know: it holds <b>$${r.melt.value}</b> of ${esc(r.melt.metal)} at today's spot — but that figure assumes the identification too.</div>` : ""}
        </div>`
      : `${r.unknown ? `<div style="margin:12px 0 0;padding:10px 12px;border:1px solid var(--line);border-left:4px solid var(--gold,#B8862F);border-radius:10px;background:var(--bg)">
          <b style="font-size:.95rem">Unknown item</b>
          <div style="font-size:.85rem;margin-top:3px">After ${r.unknown.tries} tries, ${esc(r.unknown.reason)} (${Math.round((r.unknown.confidence || 0) * 100)}% sure). No more questions.</div>
          <div class="muted" style="font-size:.8rem;margin-top:4px">The range below is a rough guess from similar items listed now. Set your own price if you know better, or add a clearer photo of any marks and re-run.</div>
        </div>` : ""}
      <div class="kpis" style="margin:12px 0">
        <div class="kpi"><div class="n">$${Math.round(pr.low)}–$${Math.round(pr.high)}</div><div class="l">${r.unknown || r.thin_evidence ? "Rough guess" : "Price range"}</div></div>
        <div class="kpi"><div class="n">$${Math.round(pr.suggested_retail)}</div><div class="l">Suggested · floor $${Math.round(pr.floor)}</div></div>
      </div>${r.thin_evidence && !r.unknown ? `<div class="muted" style="font-size:.8rem;margin:-6px 0 10px;padding:8px 10px;border-left:4px solid var(--gold,#B8862F);background:var(--bg);border-radius:8px">Few real sales to go on (${(r.comparables || []).length ? "one comparable listing" : "no comparable listings"}), so treat this as a rough guess. Check the comparables, or set your own price if you know better.</div>` : ""}`}
      ${r.lot ? `<div style="margin:8px 0;padding:8px 10px;border-left:3px solid var(--amber,#b8860b);background:var(--bg);font-size:.82rem">
          <b>$${r.lot.unit_retail} each × ${r.lot.count} pieces</b> — $${r.lot.unit_low}–$${r.lot.unit_high} per piece
          <div class="muted" style="margin-top:3px">Counted because ${esc(r.lot.how)}. The totals above are the whole lot; sold one at a time the per-piece price is what matters — check that it looks right.</div>
        </div>` : ""}
      ${r.sold_market ? `<div style="margin:8px 0;padding:8px 10px;border-left:3px solid var(--green);background:var(--bg);font-size:.82rem">
          <b>${r.sold_market.count} sold on eBay in the last 90 days</b> — $${r.sold_market.low}–$${r.sold_market.high}, median <b>$${r.sold_market.median}</b>
          <div class="muted" style="margin-top:3px">What buyers actually paid, before shipping. The best guide to what yours will fetch.</div>
          ${(r.sold_market.recent || []).length ? `<div style="margin-top:5px">${r.sold_market.recent.map(s =>
            `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><a href="${esc(epn(s.url, "gs-sold"))}" target="_blank" rel="noopener" style="color:var(--green)">$${Math.round(s.price)}${s.sold_at ? ` · ${esc(String(s.sold_at).slice(0, 10))}` : ""} — ${esc(s.title)}</a></div>`).join("")}</div>` : ""}
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
            `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><a href="${esc(epn(l.url, "gs-live"))}" target="_blank" rel="noopener" style="color:var(--cobalt)">$${Math.round(l.price)}${l.condition ? ` · ${esc(l.condition)}` : ""} — ${esc(l.title)}</a></div>`).join("")}</div>` : ""}
        </div>` : ""}
      ${nc ? "" : `<div id="shipEst" style="margin:8px 0;padding:8px 10px;border-left:3px solid var(--sub);background:var(--bg);font-size:.82rem">${r.shipping ? shipLine(r.shipping) : sizeBtnHtml("card")}</div>`}
      ${r.melt ? `<div style="margin:8px 0;padding:8px 10px;border-left:3px solid var(--green);background:var(--bg);font-size:.82rem">
          <b>Metal content:</b> ${r.melt.fine_troy_oz} ozt ${esc(r.melt.metal)} × $${r.melt.price_per_oz.toFixed(2)}/ozt = <b>$${r.melt.value} melt</b>
          <div class="muted" style="margin-top:3px">${esc(r.melt.basis)}</div>
          <div class="muted" style="margin-top:3px;font-size:.92em">${esc(r.melt.source)}, ${esc(String(r.melt.as_of).slice(0, 10))}. ${r.melt.applied === false ? "Weight is an estimate, so this has <b>not</b> been used as a price floor — weigh it to be sure." : "Scrap is a floor — never sell below it."}</div>
        </div>` : ""}
      <div class="muted" style="font-size:.82rem">${esc(pr.basis)}</div>
      ${r.evidence.length ? `<h3 style="font-size:.95rem;margin-top:12px">Why</h3><ul class="ev">${r.evidence.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
      ${r.transcribed_text.length ? `<div class="muted" style="font-size:.82rem;margin-top:6px">Read on item: ${r.transcribed_text.map(esc).join(" · ")}</div>` : ""}
      ${r.comparables.length ? `<h3 style="font-size:.95rem;margin-top:12px">Comparables</h3>${r.comparables.map(c => `<div class="split"><a href="${esc(epn(c.url, "gs-comp"))}" target="_blank" rel="noopener" style="color:var(--cobalt)">${esc(c.title)}</a><span class="amt">${c.price ? "$" + Math.round(c.price) : ""}</span></div>`).join("")}` : ""}
      ${(r.rejected_comparables || []).length ? `<details style="margin-top:8px"><summary class="muted" style="font-size:.8rem;cursor:pointer">Set aside (${r.rejected_comparables.length}) — listings not used for this price</summary>${r.rejected_comparables.map(c => `<div class="muted" style="font-size:.78rem;margin-top:4px">${esc(c.title)}${c.why ? ` — <i>${esc(c.why)}</i>` : ""}</div>`).join("")}</details>` : ""}
      ${r.questions_for_dealer.length ? `<div class="muted" style="font-size:.82rem;margin-top:10px">Would help: ${r.questions_for_dealer.map(esc).join(" · ")}</div>` : ""}
      ${r.warnings.length ? `<div class="muted" style="font-size:.75rem;margin-top:8px">${r.warnings.map(esc).join(" · ")}</div>` : ""}
      ${(r.comparables.length || (r.live_listings || []).length || r.sold_market) ? `<div class="muted" style="font-size:.7rem;margin-top:8px">eBay links are affiliate links: Guestimator may earn a small commission if you buy through them, at no cost to you.</div>` : ""}
      <div class="muted" style="font-size:.72rem;margin-top:8px">${esc(r.models.text)} + ${esc(r.models.vision)} on Nebius</div>
    </div>` : ""}
    ${r && !nc && appraisal.status === "done" ? rateCardHtml(appraisal.rating) : ""}
${r && !nc && !r.unknown && appraisal.status === "done" && pr && pr.high > 0 ? `<button class="btn sec" id="shareEst" style="margin:-4px 0 12px">📤 Share this price</button><div id="guideOpt" style="margin:-4px 0 12px;font-size:.82rem"></div>` : ""}
    ${ebayPanelHtml(b, !!(r && !nc && appraisal.status === "done") || (!appraisal && photos.length > 0))}
    ${((r && !nc && !r.unknown && appraisal.status === "done") || (!appraisal && photos.length > 0)) && item.listing_status !== "sold" ? `<div class="card" id="mktCard" style="border-color:var(--cobalt)"><b>🛒 Sell it on the Guestimator Market</b>
      <div class="muted" style="font-size:.8rem;margin:2px 0 8px">Anyone can find it and buy it on the Guestimator Market. They pay you directly. We take no cut.</div><div id="mktBody"><button class="btn" id="mktOpen" style="background:var(--cobalt)">Sell on the Market</button></div></div>` : ""}
    ${r && !nc && !r.unknown && appraisal.status === "done" && appraisal.big_piece && item.listing_status !== "sold" ? `<div class="card" id="aptCard"><b>🛋️ Big piece? AptDeco picks it up</b>
      <div class="muted" style="font-size:.8rem;margin:2px 0 8px">AptDeco sells furniture and big decor nationwide (not Alaska or Hawaii) and handles pickup and delivery for you. Unlike the Guestimator Market they keep a share: sellers get up to 70% of the sale. Use your Guestimate above to set the price.</div>
      <a class="btn sec" href="/go/aptdeco?item=${encodeURIComponent(id)}" target="_blank" rel="noopener sponsored">List it on AptDeco ↗</a>
      <div class="muted" style="font-size:.8rem;margin:12px 0 6px"><b>Sold it to someone far away?</b> uShip finds carriers for big, heavy items: list the move and carriers quote a price.</div>
      <a class="btn sec" href="/go/uship?item=${encodeURIComponent(id)}" target="_blank" rel="noopener sponsored">Get shipping quotes on uShip ↗</a>
      <div class="muted" style="font-size:.7rem;margin-top:6px">Guestimator may earn a referral fee from AptDeco or uShip. It never comes out of your sale price.</div></div>` : ""}
    ${r && !nc && !r.unknown && appraisal.status === "done" && appraisal.trade_in && item.listing_status !== "sold" ? `<div class="card" id="tradeCard"><b>📱 Want it gone today? Decluttr</b>
      <div class="muted" style="font-size:.8rem;margin:2px 0 8px">Decluttr buys phones, tablets, game consoles, video games, CDs, DVDs and Lego for a fixed price you see before you send it. It's usually less than an eBay sale, but there's no listing and no buyer to wait for. Compare their offer with your Guestimate above.</div>
      <a class="btn sec" href="/go/decluttr?item=${encodeURIComponent(id)}" target="_blank" rel="noopener sponsored">See Decluttr's offer ↗</a>
      <div class="muted" style="font-size:.7rem;margin-top:6px">Guestimator may earn a referral fee from Decluttr. It never comes out of your price.</div></div>` : ""}
    ${r && !nc && appraisal.status === "done" ? salePanelHtml() : ""}
    ${item.listing_status !== "sold" ? `<div class="card" id="soldCard" style="padding:12px 16px${state.fromSticker === id ? ";border-color:var(--green)" : ""}"><div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
      <div style="flex:1;min-width:140px"><b style="font-size:.9rem">Sold it in person?</b><div class="muted" style="font-size:.75rem">Takes it off eBay and counts it in your profit report.</div></div>
      <input id="soldIn" inputmode="decimal" placeholder="$0.00" value="${item.price_cents ? (item.price_cents / 100).toFixed(2) : r && r.price_range && r.price_range.suggested_retail ? Number(r.price_range.suggested_retail).toFixed(2) : ""}" style="width:90px">
      <button class="btn sm" id="soldGo">Mark sold</button></div></div>`
      : b.finance && b.finance.sold_cents != null ? `<div class="card" style="padding:12px 16px"><b style="font-size:.9rem">Sold in person</b> for <b>${money(b.finance.sold_cents)}</b><span class="muted" style="font-size:.8rem"> · ${esc(String(b.finance.sold_at || "").slice(0, 10))}</span></div>` : ""}    <div class="card" style="padding:12px 16px"><div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
      <div style="flex:1;min-width:140px"><b style="font-size:.9rem">What you paid</b><div class="muted" style="font-size:.75rem">For your profit report. Only you see it.</div></div>
      <input id="costIn" inputmode="decimal" placeholder="$0.00" value="${b.finance && b.finance.cost_cents != null ? (b.finance.cost_cents / 100).toFixed(2) : ""}" style="width:90px">
      <button class="btn sec sm" id="costSave">Save</button></div></div>
    <div class="row" style="gap:8px;margin-bottom:16px;flex-wrap:wrap">
      ${!pending && photos.length ? `<button class="btn sec sm" id="reappraise">${appraisal ? "↻ Re-run the estimate" : "✨ Guestimate it"}</button>` : ""}
      <a class="btn sec sm" href="/stickers?ids=${esc(id)}" target="_blank" rel="noopener" style="text-decoration:none">🏷 Print sticker</a>
      ${r && appraisal.status === "done" ? `<button class="btn sec sm" id="xpost">📋 Cross-post kit</button>` : ""}
      <button class="btn sec sm" id="delItem" style="color:var(--rust)">Delete item</button>
    </div>
`;
  $("#toItems").onclick = () => { clearTimeout(pollT); renderHome(); };
  if ($("#ebayList")) $("#ebayList").onclick = () => startEbayListing(id);
  if ($("#toSale")) $("#toSale").onclick = () => { clearTimeout(pollT); addItemToSale(id); };
  bindListingControls(id, b.ebay);
  // "Share your price": a public page (photo, range, "price yours free" via your invite link).
  if ($("#shareEst")) $("#shareEst").onclick = async () => {
    const btn = $("#shareEst"); btn.disabled = true;
    try {
      const s = await api(`/items/${id}/share`, { method: "POST" });
      const text = `Guestimator priced my ${(r.listing && r.listing.title) || (r.identification && r.identification.name) || "find"} at $${Math.round(pr.low)}–$${Math.round(pr.high)}. What's yours worth?`;
      if (navigator.share) { try { await navigator.share({ title: "What's it worth?", text, url: s.url }); } catch {} }
      else if (navigator.clipboard) { await navigator.clipboard.writeText(s.url); toast("Link copied ✓ Paste it anywhere"); }
      else prompt("Copy this link:", s.url);
    } catch (e) { toast(e.message); }
    btn.disabled = false;
  };
  if ($("#mktBody")) marketPanel(id, state.mktOpenFor !== id);
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
  if ($("#xpost")) $("#xpost").onclick = () => { clearTimeout(pollT); renderCrosspost(id); };
  if ($("#soldGo")) $("#soldGo").onclick = async () => {
    const v = $("#soldIn").value.trim();
    if (!v) { $("#soldIn").focus(); return toast("What did it sell for?"); }
    if (!confirm(`Mark sold for $${Number(v.replace(/[$,]/g, "")).toFixed(2)}? If it's listed on eBay, the listing is ended.`)) return;
    $("#soldGo").disabled = true;
    try {
      const res = await api(`/items/${id}/sold`, { method: "POST", body: JSON.stringify({ price: v }) });
      toast(res.ebay && res.ebay.ended ? "Sold ✓ and taken off eBay" : res.ebay && res.ebay.why && res.ebay.why !== "not on eBay" ? `Sold ✓ but eBay didn't end it: ${res.ebay.why}` : "Sold ✓");
      state.fromSticker = null; renderItemDetail(id);
    } catch (e) { toast(e.message); $("#soldGo").disabled = false; }
  };
  if (state.fromSticker === id && $("#soldCard")) $("#soldCard").scrollIntoView({ block: "center" });
  if ($("#costSave")) $("#costSave").onclick = async () => {
    try { await api(`/items/${id}/cost`, { method: "PUT", body: JSON.stringify({ cost: $("#costIn").value }) }); toast("Saved"); }
    catch (e) { toast(e.message); }
  };
  const cSize = app.querySelector('[data-size="card"]');
  if (cSize) cSize.onclick = async () => { const s = await sizeIt(id, cSize); if (s) { r.shipping = s; $("#shipEst").innerHTML = shipLine(s); } };
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
  app.querySelectorAll("[data-star]").forEach(btn => btn.onclick = async () => {
    try {
      const res = await api(`/items/${id}/rating`, { method: "POST", body: JSON.stringify({ stars: +btn.dataset.star, note: ($("#rateNote") || {}).value || "" }) });
      toast(res.credited ? "Thanks! +1 free estimate added" : "Thanks for rating it");
      renderItemDetail(id);
    } catch (e) { toast(e.message); }
  });
  if ($("#acceptGuess")) $("#acceptGuess").onclick = async () => {
    try { await api(`/items/${id}/accept-estimate`, { method: "POST" }); renderItemDetail(id); } catch (e) { toast(e.message); }
  };
  state.view = "item"; state.itemId = id;
  if ($("#guideBox")) guideBox(id);
  if ($("#guideOpt")) guideOptBox(id);
  if ($("#etsyBox")) etsyBox(id);
  // The 8-bit robot (robot.js) keeps its place across the 4-second re-renders instead of
  // starting over each time: it is timed from when this estimate was first seen pending.
  if (pending && $("#guessBot") && window.GuessBot) {
    botStart[id] = botStart[id] || performance.now();
    try { GuessBot.mount($("#guessBot"), { start: (performance.now() - botStart[id]) / 1000, inApp: true }); }
    catch (e) { $("#guessBot").style.display = "none"; }
  } else if (pending && $("#guessBot")) $("#guessBot").style.display = "none";   // robot.js didn't load: no empty box
  if (pending) pollT = setTimeout(() => { if (state.view === "item") renderItemDetail(id); }, 4000);
}

// "How close was it?" Ratings are the appraiser's accuracy record, and the first rating of a paid
// estimate earns a free one (capped monthly on the server).
function rateCardHtml(rating) {
  const stars = n => [1, 2, 3, 4, 5].map(i => `<button type="button" data-star="${i}" aria-label="${i} star${i > 1 ? "s" : ""}" style="background:none;border:0;font-size:1.7rem;padding:2px 4px;cursor:pointer;color:${rating && i <= rating.stars ? "var(--gold,#B8862F)" : "var(--line,#cdbf9f)"}">★</button>`).join("");
  if (rating) return `<div class="card" style="padding:10px 14px"><div class="row" style="justify-content:space-between;align-items:center;gap:8px"><span style="font-size:.9rem"><b>You rated this estimate</b>${rating.credited ? " · +1 free estimate earned" : ""}</span><span>${stars()}</span></div></div>`;
  return `<div class="card" style="padding:12px 14px">
    <b>How close was this estimate?</b> <span class="muted" style="font-size:.82rem">Rate it and get a free estimate.</span>
    <div style="margin:4px 0 2px">${stars()}</div>
    <input id="rateNote" maxlength="500" placeholder="Optional: what did it really sell for, or what was off?" style="font-size:.85rem">
  </div>`;
}

// Etsy cross-listing (vintage only): connect the shop, review, list; whichever sells first takes
// it off the other. Hidden entirely until Etsy is switched on server-side.
const ERA_LABEL = v => v === "before_1700" ? "Before 1700" : v.replace("_", "–");
async function connectEtsy() {
  try {
    const native = !!inAppBrowser();
    const { url } = await api("/etsy/connect", { method: "POST", body: JSON.stringify({ native }) });
    toast("Opening Etsy…");
    if (native) await capPlugin("Browser").open({ url }); else location.href = url;
  } catch (e) { toast(e.message); }
}
if (inAppBrowser()) {
  capPlugin("App").addListener("appUrlOpen", ev => {
    const u = String(ev && ev.url || "");
    if (!/^ai\.banksy\.bottletree:\/\/etsy\//.test(u)) return;
    capPlugin("Browser").close().catch(() => {});
    toast(/\/failed/.test(u) ? "Etsy wasn't connected — try again" : "Etsy connected ✓");
    if (state.view === "item" && state.itemId) renderItemDetail(state.itemId);
  });
}
async function etsyBox(id) {
  const box = $("#etsyBox"); if (!box) return;
  let p; try { p = await api(`/items/${id}/etsy`); } catch { return; }
  if (!p.configured) { box.innerHTML = ""; return; }
  const notice = `<div class="muted" style="font-size:.68rem;margin-top:8px">${esc(p.notice || "")}</div>`;
  const wrap = inner => `<div style="border-top:1px solid var(--line,#E0D2B4);margin-top:12px;padding-top:10px;font-size:.88rem">${inner}${notice}</div>`;
  const L = p.listing;
  if (L && L.status === "active") {
    box.innerHTML = wrap(`<b>Also on Etsy ✓</b> <a href="${esc(L.url || "#")}" target="_blank" rel="noopener" style="color:var(--cobalt);font-weight:700">View ↗</a>
      <div class="muted" style="font-size:.78rem">When it sells on either one, we take it off the other.</div>
      <button class="btn sec sm" id="etsyEnd" style="margin-top:8px">Take it off Etsy</button>`);
    $("#etsyEnd").onclick = async () => {
      if (!confirm("Take this listing off Etsy? It stays on eBay.")) return;
      try { await api(`/items/${id}/etsy/end`, { method: "POST" }); toast("Taken off Etsy"); etsyBox(id); } catch (e) { toast(e.message); }
    };
    return;
  }
  if (L && L.status === "sold") { box.innerHTML = wrap(`<b>Sold on Etsy ✓</b> Ship it from <a href="https://www.etsy.com/your/orders/sold" target="_blank" rel="noopener" style="color:var(--cobalt)">Etsy › Orders</a>.`); return; }
  if (!p.connected) {
    box.innerHTML = wrap(`<b>Also sell it on Etsy?</b><div class="muted" style="font-size:.8rem;margin:4px 0 8px">For vintage pieces (20+ years old). One tap lists it on your own Etsy shop too, and whichever sells first comes off the other.</div>
      <button class="btn sec sm" id="etsyOn">Connect my Etsy shop</button>`);
    $("#etsyOn").onclick = connectEtsy; return;
  }
  if (p.vintage === false) { box.innerHTML = wrap(`<b>Etsy</b><div class="muted" style="font-size:.8rem">${esc(p.why || "Etsy only takes vintage items from resellers.")}</div>`); return; }
  const opt = (v, t, sel) => `<option value="${esc(v)}" ${sel ? "selected" : ""}>${esc(t)}</option>`;
  const noShip = !(p.shipping_profiles || []).length;
  box.innerHTML = wrap(`<b>Also list on Etsy</b> <span class="muted" style="font-size:.78rem">(${esc(p.shop_name || "your shop")})</span>
    ${L && L.status === "error" ? `<div style="font-size:.8rem;color:var(--rust)">Last try didn't go through: ${esc(L.error || "")}</div>` : ""}
    <label style="margin-top:8px">Title</label><input id="etTitle" maxlength="140" value="${esc(p.title || "")}">
    <label>Price ($)</label><input id="etPrice" inputmode="decimal" value="${p.price_cents ? (p.price_cents / 100).toFixed(2) : ""}">
    <label>When was it made?${p.period ? ` <span class="muted" style="font-weight:400">(estimate says ${esc(p.period)})</span>` : ""}</label>
    <select id="etWhen">${p.when_made ? "" : opt("", "Pick one…", true)}${(p.when_made_choices || []).map(v => opt(v, ERA_LABEL(v), v === p.when_made)).join("")}</select>
    <label>Etsy category</label>
    <select id="etCat">${(p.categories || []).length ? p.categories.map((c, i) => opt(c.id, c.path, i === 0)).join("") : opt("", "No match found — list it from Etsy instead", true)}</select>
    <label>Shipping profile</label>
    ${noShip ? `<div style="font-size:.8rem;color:var(--rust)">Your Etsy shop has no shipping profile yet. <a href="${esc(p.shipping_help)}" target="_blank" rel="noopener" style="color:var(--cobalt)">Make one on Etsy</a>, then come back.</div>`
             : `<select id="etShip">${p.shipping_profiles.map((s, i) => opt(s.id, s.title, i === 0)).join("")}</select>`}
    <label>Description</label><textarea id="etDesc" rows="5">${esc(p.description || "")}</textarea>
    <div class="muted" style="font-size:.76rem;margin:6px 0">Etsy charges its own $0.20 listing fee to your Etsy account, plus its sale fees if it sells. Auto-renew is off.</div>
    <button class="btn" id="etsyGo" style="background:#F1641E" ${noShip ? "disabled" : ""}>List it on Etsy</button>`);
  $("#etsyGo").onclick = async () => {
    const btn = $("#etsyGo"); btn.disabled = true; btn.textContent = "Listing on Etsy…";
    try {
      const r = await api(`/items/${id}/etsy/publish`, { method: "POST", body: JSON.stringify({
        title: $("#etTitle").value, price: $("#etPrice").value, when_made: $("#etWhen").value, taxonomy_id: $("#etCat").value,
        shipping_profile_id: ($("#etShip") || {}).value, description: $("#etDesc").value }) });
      toast("Listed on Etsy ✓"); etsyBox(id);
      if (r.url) setTimeout(() => window.open(r.url, "_blank", "noopener"), 300);
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "List it on Etsy"; }
  };
}

// Not listed on eBay: the seller can still put a finished Guestimate on the public price guide.
// Off unless they tick it. No photos, name or location are ever shown.
async function guideOptBox(id) {
  const box = $("#guideOpt"); if (!box) return;
  let g; try { g = await api(`/items/${id}/guide`); } catch { return; }
  if (!g.optin || !g.optin.eligible) { box.innerHTML = ""; return; }
  box.innerHTML = `<label class="row" style="gap:8px;align-items:center;font-weight:400;margin:0"><input type="checkbox" id="guidePub" ${g.optin.on ? "checked" : ""} style="width:auto">
    <span>Add this Guestimate to the public <a href="/prices" target="_blank" rel="noopener" style="color:var(--cobalt)">price guide</a>${g.url ? ` · <a href="${esc(g.url)}" target="_blank" rel="noopener" style="color:var(--cobalt)">see its page ↗</a>` : ""}</span></label>
    <div class="muted" style="font-size:.74rem;margin-top:2px">Shows the item's name, price range and comparables. Never your photos, name or location. Untick any time.</div>`;
  $("#guidePub").onchange = async e => {
    try { await api(`/items/${id}/guide`, { method: "POST", body: JSON.stringify({ public: e.target.checked }) }); toast(e.target.checked ? "Added to the price guide" : "Removed from the price guide"); guideOptBox(id); }
    catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
  };
}
// Public price guide (/price/...): the item's page link, and the seller's switch to keep it off.
async function guideBox(id) {
  const box = $("#guideBox"); if (!box) return;
  let g; try { g = await api(`/items/${id}/guide`); } catch { return; }
  if (!g.eligible) { box.innerHTML = ""; return; }
  box.innerHTML = `<label class="row" style="gap:8px;align-items:center;font-weight:400;margin:0"><input type="checkbox" id="guideOn" ${g.hidden ? "" : "checked"} style="width:auto">
    <span>Show in the public <a href="/prices" target="_blank" rel="noopener" style="color:var(--cobalt)">price guide</a>${g.url ? ` · <a href="${esc(g.url)}" target="_blank" rel="noopener" style="color:var(--cobalt)">see its page ↗</a>` : ""}</span></label>
    <div class="muted" style="font-size:.74rem;margin-top:2px">Shows the price range and comparables, never your name or location. Helps buyers find your listing.</div>`;
  $("#guideOn").onchange = async e => {
    try { await api(`/items/${id}/guide`, { method: "POST", body: JSON.stringify({ hidden: !e.target.checked }) }); toast(e.target.checked ? "On the price guide" : "Hidden from the price guide"); guideBox(id); }
    catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
  };
}

// eBay Partner Network: links out to other people's eBay listings carry Guestimator's campaign
// id, so a purchase through them earns a commission. Only ebay.com links are touched; customid
// says which screen the click came from. Never used for the seller's own listing.
const EPN_CAMPID = "5339215150";
function epn(url, where) {
  try {
    const u = new URL(url);
    if (!/(^|\.)ebay\.com$/i.test(u.hostname)) return url;
    const p = { mkcid: "1", mkrid: "711-53200-19255-0", siteid: "0", campid: EPN_CAMPID, toolid: "10001", customid: where || "gs", mkevt: "1" };
    for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
    return u.toString();
  } catch { return url; }
}

// Estimated shipping: packed weight and box. Estimates from a photo, so it says so and says how to
// firm it up - the dealer weighs it before buying a label.
function shipLine(s) {
  const lb = n => (n < 1 ? `${Math.round(n * 16)} oz` : `${n} lb`);
  const box = (s.box_in || []).join(" × ");
  const dim = s.dim_weight_lb > Math.ceil(s.packed_weight_lb)
    ? ` UPS/FedEx will bill it as <b>${s.dim_weight_lb} lb</b> because the box is big for its weight.` : "";
  // A stock box or padded mailer when the estimate names one (newer estimates); else the exact box.
  const pk = s.package && s.package.kind !== "custom" ? s.package : null;
  if (pk) return `<b>📦 Pack it in:</b> a <b>${esc(pk.name)}</b>, about <b>${lb(pk.weight_lb || s.packed_weight_lb)}</b> packed${s.fragile ? " — <b>fragile</b>, 3 in of padding all round" : pk.kind === "box" ? ", 2 in of padding all round" : ""}.
    <div class="muted" style="margin-top:3px">Item alone ~${lb(s.item_weight_lb)}${s.basis ? ` (${esc(String(s.basis).replace(/[.\s]+$/, ""))})` : ""}. Guessed from the photos: weigh it before you buy a label.</div>`;
  return `<b>📦 Shipping estimate:</b> about <b>${lb(s.packed_weight_lb)}</b> packed, in a <b>${esc(box)} in</b> box${s.fragile ? " — <b>fragile</b>, pack with 3 in of padding" : ""}.${dim}
    <div class="muted" style="margin-top:3px">Item alone ~${lb(s.item_weight_lb)}${s.basis ? ` (${esc(String(s.basis).replace(/[.\s]+$/, ""))})` : ""}. Guessed from the photos: weigh it before you buy a label.</div>`;
}

const eShipEst = s => `<div style="font-size:.8rem;margin-top:8px">${shipLine(s)}</div>
      <button class="btn sec sm" id="eQuote" style="margin-top:8px">💲 Get real shipping prices</button><div id="eQuoteOut"></div>`;

// Items estimated before weight and box size existed: fill the gap without spending a credit.
// The server only ever adds shipping to the last estimate; it never re-prices anything.
const sizeBtnHtml = key => `<button class="btn sec sm" data-size="${key}">📦 Estimate weight &amp; box size (free)</button>`;
async function sizeIt(itemId, btn) {
  const was = btn.textContent; btn.disabled = true; btn.textContent = "Sizing it up…";
  try { const r = await api(`/items/${itemId}/shipping-estimate`, { method: "POST" }); return r.shipping; }
  catch (e) { toast(e.message); btn.disabled = false; btn.textContent = was; return null; }
}

// Live rates for the estimated box, from the seller's ZIP to near / mid / far buyers. Fills the
// price box with the suggestion only if the seller hasn't typed one; either way they can edit it.
async function getShipQuote(itemId, fromZip, btn, out, priceInput, service = "ground") {
  const zip = String(fromZip || "").trim();
  if (!/^\d{5}$/.test(zip)) { toast("Enter the 5-digit ZIP you ship from first."); return; }
  const was = btn.textContent; btn.disabled = true; btn.textContent = "Checking USPS, UPS, FedEx…";
  try {
    const q = await api(`/items/${itemId}/shipping-quote?from=${zip}&service=${service === "priority" ? "priority" : "ground"}`);
    const svc = ["usps_ground_advantage", "usps_priority", "ups_ground", "fedex_ground", "fedex_home_delivery"]
      .filter(t => q.zones.some(z => z.rates[t]));
    const name = t => (q.zones.map(z => z.rates[t]).find(Boolean) || {}).service || t;
    const cell = (z, t) => z.rates[t] ? `$${z.rates[t].amount.toFixed(2)}` : "—";
    out.innerHTML = svc.length ? `<div style="overflow-x:auto;margin-top:8px"><table style="width:100%;font-size:.78rem;border-collapse:collapse">
        <tr><th style="text-align:left;padding:3px 6px 3px 0">Service</th>${q.zones.map(z => `<th style="text-align:right;padding:3px 0 3px 6px;white-space:nowrap">${esc(z.label)}<div class="muted" style="font-weight:400">${esc(z.zip)}</div></th>`).join("")}</tr>
        ${svc.map(t => `<tr style="border-top:1px solid var(--line)"><td style="padding:3px 6px 3px 0">${esc(name(t))}</td>${q.zones.map(z => `<td style="text-align:right;padding:3px 0 3px 6px">${cell(z, t)}</td>`).join("")}</tr>`).join("")}
      </table></div>
      ${(q.flat_rate || []).length ? `<div style="font-size:.78rem;margin-top:6px">📮 <b>USPS Flat Rate</b> (same price to any distance): ${q.flat_rate.map(f => `${esc(f.name)} <b>$${f.amount.toFixed(2)}</b>`).join(" · ")}${q.zones.some(z => Object.values(z.rates).some(r => r.amount > Math.min(...q.flat_rate.map(f => f.amount)))) ? " — cheaper than some rates above." : "."}</div>` : ""}
      ${q.suggested != null ? `<div style="font-size:.8rem;margin-top:6px"><b>Suggested: $${q.suggested}</b> — ${esc(q.basis)}.</div>` : ""}
      <div class="muted" style="font-size:.72rem;margin-top:3px">Live retail rates for a ${esc(q.parcel.box_in.join(" × "))} in box at ${q.parcel.weight_lb} lb, which is our estimate. Weigh it to be sure.</div>`
      : `<div class="muted" style="font-size:.8rem;margin-top:6px">No carrier returned a rate for that box. Check the ZIP, or weigh and measure it and enter a price yourself.</div>`;
    if (priceInput && q.suggested != null && !String(priceInput.value).trim()) priceInput.value = String(q.suggested);
  } catch (e) { toast(e.message); }
  btn.disabled = false; btn.textContent = was;
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
        `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:.82rem"><a href="${esc(epn(c.url, "gs-comp"))}" target="_blank" rel="noopener" style="color:var(--cobalt)">${c.price ? "$" + Math.round(c.price) + " — " : ""}${esc(c.title)}</a></div>`).join("")}` : ""}
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
        <div class="shot" data-kind="${s.kind}"><input type="file" class="upin" accept="image/jpeg,image/png,image/webp" hidden><input type="file" class="camin" accept="image/jpeg,image/png,image/webp" capture="environment" hidden>
          <div class="ph" id="rfph-${s.kind}">📷</div><div class="sl">${s.label}</div><div class="sh">${s.hint}</div>
          <div class="shotbtns"><button type="button" class="cam">Camera</button><button type="button" class="pick">Upload</button></div></div>`).join("")}</div>
      <div style="height:8px"></div>
      <label class="btn sec sm" style="display:inline-block">+ More photos <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden id="rfMore"></label>
      <span class="muted" id="rfCount" style="font-size:.82rem;margin-left:8px"></span>`
      : `<div class="muted" style="font-size:.82rem">This item already has the maximum of 12 photos.</div>`}
    </div>
    <div class="card">
      <label>What you know about it</label>
      <textarea id="rfDesc" rows="3" placeholder="What it is, where it came from, age, condition…">${esc(splitSize(item.description).text)}</textarea>
      ${sizeBoxHtml("rfSz", splitSize(item.description).dims)}
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
    const kind = tile.dataset.kind, inp = tile.querySelector(".upin"), s = SHOTS.find(x => x.kind === kind);
    // Two direct buttons: Camera takes a picture, Upload picks an existing one.
    tile.querySelector(".pick").onclick = e => { e.preventDefault(); e.stopPropagation(); inp.click(); };
    tile.querySelector(".ph").onclick = () => tile.querySelector(".cam").click(); // tapping the picture spot = Camera
    tile.querySelector(".cam").onclick = async e => {
      e.preventDefault(); e.stopPropagation();
      if (!canUseCamera()) return tile.querySelector(".camin").click();
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
    const desc = withSize([$("#rfDesc").value.trim(), ...answers].filter(Boolean).join(". "), "rfSz");
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

// Stay current. Android resumes the app instead of restarting it, so the Android app could run
// code loaded days earlier (2026-10-05: the estimate robot showed on the web but not on Android).
// When the app comes back to the front, compare our app.js version with the live one and reload
// if it changed — only on the home or sign-in screen, so a photo or form in progress is never lost.
const ownVersion = (() => { const s = document.querySelector('script[src*="/app.js"]'); const m = s && s.src.match(/[?&]v=([^&]+)/); return m ? m[1] : null; })();
let lastVersionCheck = 0;
// Market terms (terms.js): once they are live the server answers 428 need_terms the first time a
// seller lists; ask once, then send again with agree_terms.
async function withMarketTerms(send) {
  try { return await send(false); }
  catch (e) {
    if (!e.need_terms) throw e;
    if (!confirm("To sell on the Guestimator Market you agree to the Market terms:\n" + (e.terms_url || location.origin + "/market-terms") + "\n\nOK = I agree, list it.")) throw new Error("Not listed: the Market terms weren't accepted.");
    return await send(true);
  }
}
// "Sell on the Market" card on a finished estimate (market.js sellerApi). Collapsed = just the
// button, or the listing's status if it's already in the shop. Open = the price/shipping form.
async function marketPanel(id, collapsed = false) {
  const el = $("#mktBody"); if (!el) return;
  let d;
  try { d = await api(`/market/items/${id}`); } catch (e) { el.innerHTML = `<div class="muted" style="font-size:.85rem">${esc(e.message)}</div>`; return; }
  if (!$("#mktBody")) return;
  const L = d.listed, dol = c => (c == null ? "" : (c / 100).toFixed(2).replace(/\.00$/, ""));
  const stripeNote = d.stripe.ready ? "" : `<div class="muted" style="font-size:.8rem;margin-top:8px;color:var(--rust)">Buyers can't see your shop until your Stripe account is set up (about 10 minutes, in your name). ${d.stripe.platform_on ? `<button class="btn sm" id="mktStripe" style="background:var(--cobalt);margin-top:6px">${d.stripe.connected ? "Finish Stripe setup" : "Connect Stripe"}</button>` : ""}</div>`;
  const wireStripe = () => { if ($("#mktStripe")) $("#mktStripe").onclick = async () => {
    try { const { url } = await api("/garage/stripe/connect", { method: "POST" });
      if (typeof isNative !== "undefined" && isNative && window.Capacitor?.Plugins?.Browser) await Capacitor.Plugins.Browser.open({ url }); else location.href = url; } catch (e) { toast(e.message); } }; };
  if (L && L.status === "sold") { el.innerHTML = `<div style="font-size:.9rem"><b>Sold on the Market ✓</b> <a href="${esc(L.url)}" target="_blank" rel="noopener">View</a></div>`; return; }
  if (L && L.status === "pending") { el.innerHTML = `<div style="font-size:.9rem">Someone is paying for it right now.</div>`; return; }
  if (collapsed) {
    el.innerHTML = L ? `<div style="font-size:.9rem"><b>On the Market</b> for <b>${money(L.price_cents)}</b> · ${L.ship_cents == null ? "local pickup" : L.ship_cents ? money(L.ship_cents) + " shipping" : "free shipping"}
      · <a href="${esc(L.url)}" target="_blank" rel="noopener">View</a></div><button class="btn sec sm" id="mktOpen" style="margin-top:8px">Change price or shipping</button>${stripeNote}`
      : `<button class="btn" id="mktOpen" style="background:var(--cobalt)">Sell on the Market</button>`;
    $("#mktOpen").onclick = () => { state.mktOpenFor = id; marketPanel(id, false); };
    wireStripe(); return;
  }
  const s = d.shop;
  el.innerHTML = `<div class="row" style="gap:8px"><div style="flex:1"><label>Price</label><input id="mkPrice" inputmode="decimal" value="${esc(dol(L ? L.price_cents : d.price_cents))}" placeholder="$0.00"></div>
      <div style="flex:1"><label>Shipping (0 = free)</label><input id="mkShip" inputmode="decimal" value="${esc(dol(L ? L.ship_cents : null))}" placeholder="$0.00"></div></div>
    ${d.has_size ? `<button class="btn sec sm" id="mkQuote" style="margin-top:6px">Suggest a shipping price</button><span class="muted" id="mkQuoteNote" style="font-size:.78rem;margin-left:6px"></span>` : ""}
    <div class="row" style="gap:8px;margin-top:10px"><button class="btn" id="mkGo" style="background:var(--cobalt)">${L ? "Save" : "Put it on the Market"}</button>
      ${L ? `<button class="btn sec" id="mkOff">Take it off</button>` : ""}</div>${stripeNote}`;
  wireStripe();
  if ($("#mkQuote")) $("#mkQuote").onclick = async () => {
    const zip = (s && s.zip) || d.from_zip || prompt("The 5-digit ZIP you ship from:");
    if (!zip) return;
    $("#mkQuoteNote").textContent = "Getting rates…";
    try { const q = await api(`/items/${id}/shipping-quote?from=${encodeURIComponent(zip)}&service=ground`);
      if (q.suggested) { $("#mkShip").value = q.suggested; $("#mkQuoteNote").textContent = q.basis || ""; } else $("#mkQuoteNote").textContent = q.basis || "No rate came back."; }
    catch (e) { $("#mkQuoteNote").textContent = e.message; }
  };
  $("#mkGo").onclick = async () => {
    const body = { price: $("#mkPrice").value, ship: $("#mkShip").value };
    $("#mkGo").disabled = true;
    try {
      const res = await withMarketTerms(agree => api(`/market/items/${id}`, { method: "POST", body: JSON.stringify({ ...body, ...(agree ? { agree_terms: true } : {}) }) }));
      toast(res.visible ? "On the Market ✓" : "Saved. It shows on the Market once Stripe is set up.");
      state.mktOpenFor = null; await marketPanel(id, true);
      // Listed first, then the offer: their own shop page (name, city) or a garage/estate sale.
      if (res.new_shop || res.needs_setup) offerOwnSale(res.shop_id);
    } catch (e) { toast(e.message); if ($("#mkGo")) $("#mkGo").disabled = false; }
  };
  if ($("#mkOff")) $("#mkOff").onclick = async () => {
    try { await api(`/market/items/${id}`, { method: "DELETE" }); toast("Taken off the Market"); state.mktOpenFor = null; marketPanel(id, true); } catch (e) { toast(e.message); }
  };
}

function offerOwnSale(shopId) {
  const el = $("#mktBody"); if (!el) return;
  el.insertAdjacentHTML("beforeend", `<div id="ownSale" style="margin-top:12px;padding:12px;border:1px dashed var(--cobalt);border-radius:12px">
    <b>It's listed. Want your own sale too?</b>
    <div class="muted" style="font-size:.82rem;margin:4px 0 8px">Give your shop a name and your city so buyers know who they're buying from, or start a garage, yard or estate sale page with price tags and QR codes. Both are free.</div>
    <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn sm" id="osShop" style="background:var(--cobalt)">Set up my shop page</button>
      <button class="btn sec sm" id="osSale">Start a garage sale</button><button class="btn sec sm" id="osNo">Not now</button></div></div>`);
  $("#osNo").onclick = () => $("#ownSale").remove();
  $("#osSale").onclick = () => renderSaleForm(null);
  $("#osShop").onclick = async () => { try { const d = await api("/garage/sales/" + shopId); renderSaleForm(d.sale); } catch (e) { toast(e.message); } };
}

async function reloadIfUpdated() {
  if (!ownVersion || document.visibilityState !== "visible" || Date.now() - lastVersionCheck < 60e3) return;
  if (!["home", "auth"].includes(state.view)) return;
  lastVersionCheck = Date.now();
  try {
    const html = await (await fetch("/", { cache: "no-store" })).text();
    const m = html.match(/\/app\.js\?v=([^"'&>]+)/);
    if (m && m[1] !== ownVersion && ["home", "auth"].includes(state.view)) location.reload();
  } catch {}
}
document.addEventListener("visibilitychange", reloadIfUpdated);
window.addEventListener("focus", reloadIfUpdated);

// boot: check session, then show your items or the sign-in screen
(async function init() {
  // Back from Google's redirect sign-in (iPhone/iPad) without a session: say so.
  if (new URLSearchParams(location.search).get("google") === "failed") {
    history.replaceState(null, "", "/");
    setTimeout(() => toast("Google sign-in didn't go through. Try again, or use email and password."), 800);
  }
  try {
    const me = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (me.ok) {
      const d = await me.json(); user = d.email; state.owner = !!d.owner; afterSignIn();
      // Back from eBay's sign-in in a browser tab: the callback redirected to /?ebay=connected.
      const fromEbay = new URLSearchParams(location.search).get("ebay") === "connected";
      // Back from connecting a Shippo account (labels billed to the seller).
      const shippoBack = new URLSearchParams(location.search).get("shippo");
      if (shippoBack) { history.replaceState(null, "", "/" + location.hash); setTimeout(() => toast(shippoBack === "connected" ? "Shippo connected ✓ You can buy labels now." : "Shippo wasn't connected. Try again from a sale."), 600); }
      if (fromEbay) history.replaceState(null, "", "/");
      // Back from connecting an Etsy shop in a browser tab.
      const etsyBack = new URLSearchParams(location.search).get("etsy");
      if (etsyBack) { history.replaceState(null, "", "/"); setTimeout(() => toast(etsyBack === "connected" ? "Etsy connected ✓ Open a listed vintage item to put it on Etsy too." : "Etsy wasn't connected. Try again from an item."), 600); }
      // Back from paying for a shipping label (Stripe Checkout): buy it now, then show the order.
      const lp = new URLSearchParams(location.search), labelPaid = lp.get("labelpaid");
      if (labelPaid) {
        history.replaceState(null, "", "/");
        if (lp.get("cancelled")) setTimeout(() => toast("Label not bought - checkout was cancelled."), 600);
        else {
          try {
            const r = await api("/labels/paid", { method: "POST", body: JSON.stringify({ id: labelPaid }) });
            toast("Label bought ✓ Print it from the order.");
            if (r.label && r.label.kind === "ebay") { await renderEbayOrders(); return; }
          } catch (e) { setTimeout(() => toast(e.message), 600); }
        }
      }
      // #ebay-orders: the link in a "Sold on eBay" email.
      // #item-<id>: the QR on an inventory sticker.
      const itemHash = (location.hash.match(/^#item-([0-9a-f-]{36})$/) || [])[1];
      if (itemHash && !fromEbay) { state.fromSticker = itemHash; await renderItemDetail(itemHash); }
      else if (location.hash === "#ebay-orders" && !fromEbay) await renderEbayOrders();
      else if (!(await afterStripeReturn())) await renderHome();
      if (fromEbay) afterEbayReturn(true);
    }
    else renderAuth();
  } catch { renderAuth(); }
})();

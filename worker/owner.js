// Owner dashboard (/owner): one private page with how Guestimator is doing - signups, estimates,
// listings, sales, label money, and anything that failed in the background. Only the owner
// (ADMIN_EMAIL, else the first LABEL_USERS address) can open it; everyone else gets a 404.
// Note: `users` is shared with Bottle Tree (same D1), so "signups" counts both apps' accounts;
// "made an estimate" is the Guestimator-specific number.

import * as labelpay from "./labelpay.js";
import { adminEmail } from "./shipops.js";
import * as feedback from "./feedback.js";
import { parsePromoCodes } from "./billing.js";
import * as growth from "./growth.js";
import * as quota from "./quota.js";
import * as partners from "./partners.js";
import * as accuracy from "./accuracy.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = c => "$" + (Number(c || 0) / 100).toFixed(2);
const iso = ms => new Date(ms).toISOString();

export const isOwner = (env, email) => !!email && !!adminEmail(env) && String(email).toLowerCase() === adminEmail(env).toLowerCase();

/** Records a background-job failure for the dashboard (never throws). Prunes after 30 days. */
export async function opsFail(db, job, e, ms = Date.now()) {
  try {
    await db.prepare("INSERT INTO ops_errors (at, job, message) VALUES (?,?,?)").bind(iso(ms), String(job).slice(0, 60), String((e && e.message) || e).slice(0, 500)).run();
    await db.prepare("DELETE FROM ops_errors WHERE at<?").bind(iso(ms - 30 * 86400e3)).run();
  } catch {}
}

const one = async (db, sql, ...b) => (await db.prepare(sql).bind(...b).first()) || {};
const all = async (db, sql, ...b) => (await db.prepare(sql).bind(...b).all()).results || [];

export async function ownerStats(db, env, ms = Date.now()) {
  const d7 = iso(ms - 7 * 86400e3), d30 = iso(ms - 30 * 86400e3);
  const users = await one(db, `SELECT COUNT(*) total, SUM(created_at>=?) new7, SUM(created_at>=?) new30,
      (SELECT COUNT(DISTINCT s.user_id) FROM appraisals a JOIN items i ON i.id=a.item_id JOIN sales s ON s.id=i.sale_id) estimators,
      (SELECT COUNT(DISTINCT s.user_id) FROM appraisals a JOIN items i ON i.id=a.item_id JOIN sales s ON s.id=i.sale_id WHERE a.created_at>=?) active7
    FROM users`, d7, d30, d7);
  const est = await one(db, `SELECT SUM(created_at>=?) n7, SUM(created_at>=?) n30, SUM(created_at>=? AND status='error') err7,
      SUM(status='pending' AND created_at<?) stuck FROM appraisals`, d7, d30, d7, iso(ms - 30 * 60e3));
  // Real money only: RevenueCat purchases/renewals (not spends, refunds, grants, promos, welcome credits).
  const paid = await one(db, `SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN credits_delta>0 THEN credits_delta END),0) credits FROM billing_events
      WHERE created_at>=? AND source='revenuecat' AND type IN ('INITIAL_PURCHASE','NON_RENEWING_PURCHASE','RENEWAL')`, d30);
  const ebay = await one(db, `SELECT (SELECT COUNT(*) FROM ebay_accounts) accounts,
      (SELECT COUNT(*) FROM ebay_listings WHERE status='published') live,
      (SELECT COUNT(*) FROM ebay_listings WHERE status='error' AND updated_at>=?) err7,
      (SELECT COUNT(*) FROM ebay_orders WHERE status<>'CANCELLED' AND ordered_at>=?) sold30,
      (SELECT COALESCE(SUM(total_cents),0) FROM ebay_orders WHERE status<>'CANCELLED' AND ordered_at>=?) gmv30`, d7, d30, d30);
  const garage = await one(db, `SELECT (SELECT COUNT(*) FROM garage_sales WHERE status='published') live,
      (SELECT COUNT(*) FROM garage_orders WHERE status IN ('paid','fulfilled') AND created_at>=?) sold30,
      (SELECT COALESCE(SUM(total_cents),0) FROM garage_orders WHERE status IN ('paid','fulfilled') AND created_at>=?) gmv30,
      (SELECT COALESCE(SUM(fee_cents),0) FROM garage_orders WHERE status IN ('paid','fulfilled') AND created_at>=?) fees30`, d30, d30, d30);
  // Guestimator Market (market.js): shops, what buyers can see right now, orders, page views.
  const market = await one(db, `SELECT (SELECT COUNT(*) FROM garage_sales WHERE kind='shop') shops,
      (SELECT COUNT(*) FROM garage_sales g JOIN users u ON u.id=g.user_id WHERE g.kind='shop' AND u.stripe_payouts_ready=1) shops_ready,
      (SELECT COUNT(*) FROM garage_sale_items gi JOIN garage_sales g ON g.id=gi.sale_id WHERE g.kind='shop' AND gi.status='available') listed,
      (SELECT COUNT(*) FROM garage_sale_items gi JOIN garage_sales g ON g.id=gi.sale_id JOIN users u ON u.id=g.user_id
        WHERE g.kind='shop' AND g.status='published' AND g.online_ok=1 AND gi.status='available' AND u.stripe_payouts_ready=1
          AND ((g.ship_ok=1 AND gi.ship_cents IS NOT NULL) OR g.pickup_ok=1)) visible,
      (SELECT COUNT(*) FROM garage_orders o JOIN garage_sales g ON g.id=o.sale_id WHERE g.kind='shop' AND o.status IN ('paid','fulfilled') AND o.created_at>=?) sold30,
      (SELECT COALESCE(SUM(o.total_cents),0) FROM garage_orders o JOIN garage_sales g ON g.id=o.sale_id WHERE g.kind='shop' AND o.status IN ('paid','fulfilled') AND o.created_at>=?) gmv30,
      (SELECT COALESCE(SUM(views),0) FROM market_views WHERE day>=?) views7,
      (SELECT COALESCE(SUM(views),0) FROM market_views WHERE day>=?) views30`, d30, d30, d7.slice(0, 10), d30.slice(0, 10)).catch(() => ({}));
  // Promo codes (PROMO_CODES secret): which exist, how many credits, the cap, and uses so far.
  const promos = await Promise.all(Object.entries(parsePromoCodes(env.PROMO_CODES)).map(async ([code, c]) => ({ code, credits: c.credits, max: c.max,
    used: ((await db.prepare("SELECT COUNT(*) n FROM billing_events WHERE source='promo' AND product_id=?").bind(code).first()) || {}).n || 0 })));
  const labelPays = await all(db, "SELECT status, COUNT(*) n, COALESCE(SUM(total_cents),0) cents FROM label_payments GROUP BY status ORDER BY n DESC");
  const labelProblems = await all(db, `SELECT p.status, p.kind, p.order_id, p.total_cents, p.error, p.payment_intent, p.updated_at, u.email FROM label_payments p JOIN users u ON u.id=p.user_id
      WHERE p.status IN ('stuck','refunded','buying') AND p.updated_at>=? ORDER BY p.updated_at DESC LIMIT 10`, d30);
  const voids = await one(db, "SELECT SUM(void_status IN ('QUEUED','PENDING')) pending, SUM(void_status='ERROR') refused FROM shipping_labels WHERE void_of IS NOT NULL");
  const jobErrors = await all(db, "SELECT job, COUNT(*) n, MAX(at) last FROM ops_errors WHERE at>=? GROUP BY job ORDER BY n DESC", d7);
  const lastErrors = await all(db, "SELECT at, job, message FROM ops_errors ORDER BY at DESC LIMIT 8");
  const estErrors = await all(db, "SELECT a.created_at at, a.error message FROM appraisals a WHERE a.status='error' ORDER BY a.created_at DESC LIMIT 5");
  const listErrors = await all(db, "SELECT updated_at at, error message FROM ebay_listings WHERE status='error' ORDER BY updated_at DESC LIMIT 5");
  const recent = await all(db, `SELECT u.email, u.created_at, (SELECT COUNT(*) FROM appraisals a JOIN items i ON i.id=a.item_id JOIN sales s ON s.id=i.sale_id WHERE s.user_id=u.id) estimates,
      EXISTS (SELECT 1 FROM ebay_accounts e WHERE e.user_id=u.id) ebay FROM users u ORDER BY u.created_at DESC LIMIT 12`);
  const funnel = await growth.funnelByWeek(db, ms);
  const winback = await growth.winbackCandidates(env, db, adminEmail(env));
  const unsent = await growth.winbackUnsent(db);
  const winbackPreview = growth.winbackFreeMail(env, env.PUBLIC_ORIGIN || "https://app.theguestimator.com", Math.min(20, Math.max(1, Math.floor(Number(env.SIGNUP_CREDITS ?? 5)) || 5)), "(their own unsubscribe link)").text;
  const alerts = await quota.recentAlerts(db).catch(() => []);
  const aptClicks = await partners.clicks30(db);
  const sources = (await db.prepare(`SELECT COALESCE(u.signup_source, '(unknown)') src, COALESCE(u.signup_campaign, '') camp, COUNT(*) n,
      SUM(EXISTS (SELECT 1 FROM sales s JOIN items i ON i.sale_id=s.id JOIN appraisals a ON a.item_id=i.id WHERE s.user_id=u.id)) est
    FROM users u WHERE u.created_at>=? GROUP BY 1,2 ORDER BY n DESC LIMIT 20`).bind(d30).all().catch(() => ({ results: [] }))).results || [];
  const acc = await accuracy.accuracyRows(db).catch(() => []);
  return { at: iso(ms), alerts, aptClicks, sources, acc, accSum: accuracy.summary(acc), funnel, winback, unsent, winbackPreview, users, est, paid, ebay, garage, market, promos, feedback: await feedback.ownerList(db).catch(() => []), labels: { used: await labelpay.monthCount(db, ms), cap: labelpay.houseCap(env), pay_on: labelpay.payOn(env), payments: labelPays, problems: labelProblems, voids },
           errors: { jobs: jobErrors, last: lastErrors, estimates: estErrors, listings: listErrors }, recent };
}

const n = v => Number(v || 0);
const pct = (a, b) => n(b) ? ` <span class="m">(${Math.round(100 * n(a) / n(b))}%)</span>` : "";
const when = s => s ? esc(String(s).slice(0, 16).replace("T", " ")) : "";

export function ownerPage(s) {
  const tile = (label, value, sub, bad) => `<div class="t${bad ? " bad" : ""}"><div class="l">${esc(label)}</div><div class="v">${value}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
  const table = (head, rows, empty) => `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.join("") : `<tr><td colspan="${head.length}" class="m">${esc(empty)}</td></tr>`}</tbody></table>`;
  const L = s.labels, capPct = L.cap ? Math.round(100 * L.used / L.cap) : 0;
  const problems = n(s.est.stuck) + L.problems.filter(p => p.status !== "refunded").length + n(L.voids.refused) + s.errors.jobs.reduce((a, j) => a + j.n, 0);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Guestimator owner</title>
<style>:root{--bg:#f4ecdc;--card:#fbf6ea;--ink:#241b10;--mut:#6a5b44;--line:#e0d2b4;--bad:#a63d24;--ok:#0f6b59}
@media (prefers-color-scheme:dark){:root{--bg:#17130d;--card:#221c14;--ink:#f1e7d3;--mut:#b3a387;--line:#3a3022;--bad:#e0806a;--ok:#5cc2a8}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
.w{max-width:980px;margin:0 auto;padding:16px}h1{font:700 1.5rem Georgia,serif;margin:4px 0}h2{font-size:1rem;margin:22px 0 8px}
.m{color:var(--mut);font-size:.82rem}.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.t{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px}.t .l{font-size:.75rem;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.t .v{font-size:1.5rem;font-weight:800;font-variant-numeric:tabular-nums}.t .s{font-size:.78rem;color:var(--mut)}.t.bad{border-color:var(--bad)}.t.bad .v{color:var(--bad)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:.84rem}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:.72rem;color:var(--mut);text-transform:uppercase}
.bar{height:8px;background:var(--line);border-radius:6px;overflow:hidden;margin-top:6px}.bar i{display:block;height:100%;background:${capPct >= 100 ? "var(--bad)" : capPct >= 80 ? "#c08a1c" : "var(--ok)"}}
.ok{color:var(--ok);font-weight:700}.err{color:var(--bad);font-weight:700}.sc{overflow-x:auto}a{color:inherit}</style></head><body><div class="w">
<h1>Guestimator owner</h1><div class="m">As of ${when(s.at)} UTC · <a href="/owner">refresh</a> · <a href="/">back to the app</a></div>
<div style="margin-top:12px">${problems ? `<span class="err">⚠ ${problems} thing${problems === 1 ? "" : "s"} need a look</span> (see below)` : `<span class="ok">✓ Nothing needs a look</span>`}</div>
<h2>People</h2><div class="g">
${tile("Accounts", n(s.users.total), `+${n(s.users.new7)} this week · +${n(s.users.new30)} in 30 days`)}
${tile("Made an estimate", n(s.users.estimators), `${n(s.users.active7)} active this week`)}
${tile("Estimates", n(s.est.n7), `this week · ${n(s.est.n30)} in 30 days`)}
${tile("Paid purchases", n(s.paid.n), `30 days (RevenueCat) · ${n(s.paid.credits)} credits`)}</div>
<h2>Sign-ups by week (Guestimator accounts)</h2><div class="sc">${table(["Week of", "Signed up", "Made an estimate", "Listed on eBay", "Sold", "Paid"],
  s.funnel.map(w => `<tr><td>${esc(w.first_day)}</td><td>${n(w.signed)}</td><td>${n(w.estimated)}${pct(w.estimated, w.signed)}</td><td>${n(w.listed)}${pct(w.listed, w.signed)}</td><td>${n(w.sold)}</td><td>${n(w.paid)}</td></tr>`), "No sign-ups in the last 8 weeks.")}</div>
<h2>Never ran an estimate</h2>${s.winback.length ? `<div class="m" style="margin-bottom:8px">These people signed up before estimates were free, so their first try hit "buy credits". The button gives each one free estimates (up to 3) and sends them <b>one</b> email, once. Untick anyone to leave them out.</div>
<div class="sc">${table(["", "Signed up", "Email", "Credits now", "Old reminder sent"], s.winback.map(c => `<tr><td><input type="checkbox" class="wb" value="${esc(c.user_id)}" checked></td><td>${when(c.created_at)}</td><td>${esc(c.email)}</td><td>${n(c.credits)}</td><td>${c.winback1_at ? when(c.winback1_at) : ""}</td></tr>`), "")}</div>
<details style="margin:10px 0"><summary class="m" style="cursor:pointer">Show the email they'll get</summary><div class="t" style="margin-top:6px;white-space:pre-wrap;font-size:.85rem">${esc(s.winbackPreview)}</div></details>
<button id="wbGo" style="font:inherit;font-weight:700;padding:10px 16px;border-radius:10px;border:0;background:var(--ok);color:#fff;cursor:pointer">Give free estimates &amp; send the email</button> <span id="wbOut" class="m"></span>
<script>document.getElementById("wbGo").onclick=async function(){var ids=[].slice.call(document.querySelectorAll(".wb:checked")).map(function(x){return x.value});if(!ids.length)return;if(!confirm("Give free estimates and email "+ids.length+" "+(ids.length===1?"person":"people")+"? Each gets it once."))return;this.disabled=true;var o=document.getElementById("wbOut");o.textContent="Sending…";try{var r=await fetch("/owner/winback",{method:"POST",headers:{"content-type":"application/json","x-gs-owner":"1"},body:JSON.stringify({ids:ids}),credentials:"same-origin"});var j=await r.json();o.textContent=r.ok?("Done: "+j.sent+" sent. Refresh to see the list update."):("Didn't go: "+(j.error||r.status));}catch(e){o.textContent="Didn't go: "+e.message;this.disabled=false}};</script>` : `<div class="m">Nobody waiting. Everyone has either run an estimate or already had their free estimates.</div>`}
${s.unsent.length ? `<h2>Got free credits, but the email didn't arrive</h2><div class="m" style="margin-bottom:8px">Their credits are in place; the email was refused. Cloudflare only delivers to addresses verified in your account until <b>Email Sending</b> is turned on for theguestimator.com. Once it is, send these again.</div>
<div class="sc">${table(["", "Credits given", "Email", "Credits now", "Why it didn't go"], s.unsent.map(c => `<tr><td><input type="checkbox" class="rs" value="${esc(c.user_id)}" checked></td><td>${when(c.created_at)}</td><td>${esc(c.email)}</td><td>${n(c.credits)}</td><td class="err">${esc(c.why || "not confirmed")}</td></tr>`), "")}</div>
<button id="rsGo" style="font:inherit;font-weight:700;padding:10px 16px;border-radius:10px;border:0;background:var(--ok);color:#fff;cursor:pointer;margin-top:8px">Send the email again</button> <span id="rsOut" class="m"></span>
<script>document.getElementById("rsGo").onclick=async function(){var ids=[].slice.call(document.querySelectorAll(".rs:checked")).map(function(x){return x.value});if(!ids.length)return;this.disabled=true;var o=document.getElementById("rsOut");o.textContent="Sending…";try{var r=await fetch("/owner/winback-resend",{method:"POST",headers:{"content-type":"application/json","x-gs-owner":"1"},body:JSON.stringify({ids:ids}),credentials:"same-origin"});var j=await r.json();o.textContent=r.ok?(j.sent+" sent"+(j.failed.length?", "+j.failed.length+" still refused: "+(j.failed[0].why||""):"")+". Refresh to update."):("Didn't go: "+(j.error||r.status));}catch(e){o.textContent="Didn't go: "+e.message}this.disabled=false};</script>` : ""}
<h2>Mail check</h2><div class="m">Send a one-line test email to any address and see exactly what the mail service says. <input id="mtTo" type="email" placeholder="someone@example.com" style="font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink)"> <button id="mtGo" style="font:inherit;font-weight:700;padding:6px 12px;border-radius:8px;border:0;background:var(--ink);color:var(--bg);cursor:pointer">Send test</button> <span id="mtOut"></span></div>
<script>document.getElementById("mtGo").onclick=async function(){var to=document.getElementById("mtTo").value.trim(),o=document.getElementById("mtOut");if(!to)return;o.textContent="…";try{var r=await fetch("/owner/mailtest",{method:"POST",headers:{"content-type":"application/json","x-gs-owner":"1"},body:JSON.stringify({to:to}),credentials:"same-origin"});var j=await r.json();o.innerHTML=j.sent?'<span class="ok">✓ accepted for delivery</span>':'<span class="err">✗ '+(j.why||j.error||r.status)+'</span>';}catch(e){o.textContent=e.message}};</script>
<h2>Selling</h2><div class="g">
${tile("eBay accounts", n(s.ebay.accounts), `${n(s.ebay.live)} listings live`)}
${tile("eBay sales", n(s.ebay.sold30), `30 days · ${money(s.ebay.gmv30)}`)}
${tile("Garage sales live", n(s.garage.live), "")}
${tile("Garage online sales", n(s.garage.sold30), `30 days · ${money(s.garage.gmv30)}`)}</div>
<h2>Guestimator Market</h2><div class="g">
${tile("AptDeco clicks (30 days)", n(s.aptClicks), "big pieces sent to AptDeco")}
${tile("Market page views", n((s.market || {}).views7), `7 days · ${n((s.market || {}).views30)} in 30 days`)}
${tile("Shops opened", n((s.market || {}).shops), `${n((s.market || {}).shops_ready)} can take payment (Stripe ready)`)}
${tile("Items buyers can see", n((s.market || {}).visible), `${n((s.market || {}).listed)} in shops in all`)}
${tile("Market sales", n((s.market || {}).sold30), `30 days · ${money((s.market || {}).gmv30)} · we take no cut`)}</div>
<h2>Promo codes</h2><div class="m" style="margin-bottom:8px">From the PROMO_CODES secret. Each account can use each code once.</div>
<div class="sc">${table(["Code", "Credits", "Used", "Cap"], (s.promos || []).map(p => `<tr><td><b>${esc(p.code)}</b></td><td>${n(p.credits)}</td><td>${n(p.used)}</td><td${p.max && p.used >= p.max ? ' class="err"' : ""}>${p.max ? n(p.max) + (p.used >= p.max ? " (used up)" : "") : "no cap"}</td></tr>`), "No codes set: the PROMO_CODES secret is missing or empty.")}</div>
<h2>Feedback (${(s.feedback || []).filter(f => f.status === "new").length} new)</h2>
<div class="m" style="margin-bottom:8px">From the app's Feedback button. Set Planned or Done and the sender gets one email (with your note, if any) and sees it under "Your feedback".</div>
<div class="sc">${table(["When", "From", "Kind", "Message", "Status", "Note to them", ""], (s.feedback || []).map(f => `<tr data-fb="${esc(f.id)}"><td>${when(f.created_at)}</td><td>${esc(f.email || "")}</td><td>${esc(feedback.KINDS[f.kind] || f.kind)}</td>
<td style="max-width:420px;white-space:pre-wrap">${esc(f.message)}${f.page ? `<div class="m">screen: ${esc(f.page)}</div>` : ""}</td>
<td><select class="fbS">${Object.entries(feedback.STATUSES).map(([k, v]) => `<option value="${k}"${f.status === k ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></td>
<td><input class="fbN" value="${esc(f.owner_note || "")}" placeholder="optional" style="font:inherit;width:180px"></td><td><button class="fbGo">Save</button> <span class="fbOut m"></span></td></tr>`), "No feedback yet.")}</div>
<script>document.querySelectorAll(".fbGo").forEach(function(b){b.onclick=async function(){var tr=b.closest("tr"),o=tr.querySelector(".fbOut");o.textContent="…";try{var r=await fetch("/owner/feedback",{method:"POST",headers:{"content-type":"application/json","x-gs-owner":"1"},credentials:"same-origin",body:JSON.stringify({id:tr.dataset.fb,status:tr.querySelector(".fbS").value,note:tr.querySelector(".fbN").value})});var j=await r.json();o.textContent=r.ok?("saved"+(j.emailed?", emailed them":"")):(j.error||r.status);}catch(e){o.textContent=e.message}}});</script>
<h2>Shipping labels</h2><div class="g">
<div class="t${capPct >= 100 ? " bad" : ""}"><div class="l">House Shippo this month</div><div class="v">${n(L.used)} / ${n(L.cap)}</div><div class="bar"><i style="width:${Math.min(100, capPct)}%"></i></div><div class="s">Card-paid labels ${L.pay_on ? "on" : "off"}</div></div>
${L.payments.map(p => tile(`Payments: ${p.status}`, n(p.n), money(p.cents), p.status === "stuck")).join("")}
${tile("Voids pending", n(L.voids.pending), `${n(L.voids.refused)} refused by Shippo`, n(L.voids.refused) > 0)}</div>
${L.problems.length ? `<h2>Label payments to check (30 days)</h2><div class="sc">${table(["When", "Status", "Seller", "Order", "Charged", "Stripe", "Why"],
  L.problems.map(p => `<tr><td>${when(p.updated_at)}</td><td class="${p.status === "refunded" ? "" : "err"}">${esc(p.status)}</td><td>${esc(p.email)}</td><td>${esc(p.kind)} ${esc(p.order_id)}</td><td>${money(p.total_cents)}</td><td>${esc(p.payment_intent || "")}</td><td>${esc(p.error || "")}</td></tr>`), "")}</div>` : ""}
<h2>Sign-ups by source (30 days)</h2><div class="m" style="margin-bottom:8px">From the link people first arrived on (utm_source / utm_campaign, else the referring site). Counting started 2026-10-07; older accounts show as (unknown).</div><div class="sc">${table(["Source", "Campaign", "Sign-ups", "Made a Guestimate"], (s.sources || []).map(r => `<tr><td>${esc(r.src)}</td><td>${esc(r.camp)}</td><td>${n(r.n)}</td><td>${n(r.est)}${pct(r.est, r.n)}</td></tr>`), "No sign-ups in 30 days.")}</div>
<h2>Guestimate vs. what it sold for</h2>${(() => { const A = s.accSum || {}; const rows = s.acc || [];
  return `<div class="g">${tile("Sold items", n(A.sold), "with a known sale price")}${tile("Sold inside the range", A.priced ? `${n(A.inRange)}/${n(A.priced)}` : "–", A.priced ? `${Math.round(100 * n(A.inRange) / n(A.priced))}%` : "no data yet")}${tile("Sold ÷ middle of range", A.median != null ? A.median + "×" : "–", "median; over 1 = we guess low")}${tile("Seller rating", A.avgStars != null ? A.avgStars + "★" : "–", `${n(A.rated)} rated`)}</div>
  <div class="sc" style="margin-top:10px">${table(["Sold", "Item", "Via", "Guestimate", "Sold for", "Result", "Stars"], rows.map(r => `<tr><td>${when(r.at)}</td><td>${esc(r.name)}</td><td>${esc(r.via)}</td><td>${r.hi ? "$" + r.lo + "–$" + r.hi : "–"}</td><td>$${r.sold.toFixed(2)}</td><td class="${r.tag === "in range" ? "" : "err"}">${esc(r.tag)}${r.ratio != null ? " (" + r.ratio + "×)" : ""}</td><td>${r.stars != null ? r.stars + "★" : ""}</td></tr>`), "Nothing has sold with a Guestimate yet.")}</div>`; })()}
<h2>Service limits (7 days)</h2>${(s.alerts || []).length ? `<div class="sc">${table(["Service", "Last hit", "Times", "Message", "What to do"], s.alerts.map(a => `<tr><td class="err"><b>${esc(a.name)}</b></td><td>${when(a.last_seen)}</td><td>${n(a.hits)}</td><td>${esc(a.message)}</td><td>${esc(a.fix)}</td></tr>`), "")}</div>` : `<div class="m">No paid service has run out in the last 7 days.</div>`}
<h2>Background jobs & failures</h2><div class="g">
${tile("Job failures (7 days)", s.errors.jobs.reduce((a, j) => a + j.n, 0), s.errors.jobs.map(j => `${esc(j.job)} ×${j.n}`).join(" · ") || "none", s.errors.jobs.length > 0)}
${tile("Estimates failed (7 days)", n(s.est.err7), n(s.est.stuck) ? `${n(s.est.stuck)} stuck pending` : "", n(s.est.stuck) > 0)}
${tile("Listing errors (7 days)", n(s.ebay.err7), "")}</div>
<div class="sc" style="margin-top:10px">${table(["When", "What", "Message"], [
  ...s.errors.last.map(e => `<tr><td>${when(e.at)}</td><td>job: ${esc(e.job)}</td><td>${esc(e.message)}</td></tr>`),
  ...s.errors.estimates.map(e => `<tr><td>${when(e.at)}</td><td>estimate</td><td>${esc(e.message)}</td></tr>`),
  ...s.errors.listings.map(e => `<tr><td>${when(e.at)}</td><td>eBay listing</td><td>${esc(e.message)}</td></tr>`)], "No failures recorded.")}</div>
<h2>Newest accounts</h2><div class="sc">${table(["Signed up", "Email", "Estimates", "eBay"],
  s.recent.map(u => `<tr><td>${when(u.created_at)}</td><td>${esc(u.email)}</td><td>${n(u.estimates)}</td><td>${u.ebay ? "✓" : ""}</td></tr>`), "No accounts.")}</div>
<p class="m">Accounts are shared with Bottle Tree, so "Accounts" counts both apps; "Made an estimate" is Guestimator use.</p>
</div></body></html>`;
}

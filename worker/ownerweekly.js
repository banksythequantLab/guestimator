// Owner's Monday report (2026-10-08): one email to the owner with the week at a glance - sign-ups
// and where they came from, Guestimates, sales, Guestimate-vs-sold accuracy, partner clicks and
// anything that broke. Built from ownerStats (the /owner page's own numbers), so the email and the
// page never disagree. Sent once per ISO week from Monday 13:00 UTC; owner_reports is the gate.

import { ownerStats } from "./owner.js";
import { adminEmail } from "./shipops.js";
import { sendAlert } from "./notify.js";
import { inSendWindow } from "./weekly.js";
import { MARKET_TAX_CHECK_CENTS } from "./terms.js";

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const n = v => Number(v || 0);
const usd = c => "$" + Math.round(n(c) / 100).toLocaleString("en-US");
export const weekKey = ms => { const d = new Date(ms); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

export function ownerWeeklyEmail(s, origin) {
  const u = s.users || {}, e = s.est || {}, eb = s.ebay || {}, mk = s.market || {}, a = s.accSum || {};
  const pc = s.partnerClicks || {}, clicks = Object.values(pc).reduce((x, y) => x + n(y), 0);
  const jobErr = (s.errors && s.errors.jobs || []).reduce((x, j) => x + n(j.n), 0);
  const sec = [
    ["Sign-ups", [`${n(u.new7)} new this week (${n(u.new30)} in 30 days, ${n(u.total)} total)`, `${n(u.active7)} people made a Guestimate this week`,
      ...(s.sources || []).slice(0, 6).map(r => `  ${r.src}${r.camp ? " / " + r.camp : ""}: ${n(r.n)} sign-up${n(r.n) === 1 ? "" : "s"}, ${n(r.est)} made a Guestimate (30 days)`)]],
    ["Guestimates", [`${n(e.n7)} this week (${n(e.n30)} in 30 days)`, ...(n(e.err7) ? [`${n(e.err7)} failed this week`] : []), ...(n(e.stuck) ? [`${n(e.stuck)} stuck pending`] : [])]],
    ["Sales (30 days)", [`eBay: ${n(eb.sold30)} orders, ${usd(eb.gmv30)} · ${n(eb.live)} listings live`, `Guestimator Market: ${n(mk.sold30)} orders, ${usd(mk.gmv30)} · ${n(mk.visible)} items buyers can see`,
      ...(n(mk.gmv365) >= MARKET_TAX_CHECK_CENTS ? [`CHECK-IN: Market sales passed $50,000 in the last 12 months (${usd(mk.gmv365)}). Revisit sales tax before any state threshold.`] : [])]],
    ["Guestimate vs. what it sold for", [a.priced ? `${n(a.inRange)} of ${n(a.priced)} sales landed in the Guestimate range; median sale ${a.median}x the middle of the range` : "No sales to compare yet",
      ...(s.acc || []).slice(0, 4).map(r => `  ${r.name}: Guestimate $${r.lo}-$${r.hi}, sold $${r.sold} (${r.tag})`)]],
    ["Partners (30 days)", [clicks ? `${clicks} clicks: AptDeco ${n(pc.aptdeco)}, uShip ${n(pc.uship)}, Decluttr ${n(pc.decluttr)}` : "No partner clicks yet"]],
    ["Problems", [jobErr || (s.alerts || []).length ? `${jobErr} background-job error${jobErr === 1 ? "" : "s"} this week, ${(s.alerts || []).length} service-limit alert${(s.alerts || []).length === 1 ? "" : "s"}` : "Nothing failed this week"]],
  ];
  const subject = `Guestimator week: ${n(u.new7)} sign-up${n(u.new7) === 1 ? "" : "s"}, ${n(e.n7)} Guestimate${n(e.n7) === 1 ? "" : "s"}`;
  const text = [subject, "", ...sec.flatMap(([h, ls]) => [h, ...ls.map(l => l.startsWith("  ") ? l : "- " + l), ""]), `Everything: ${origin}/owner`].join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#fff;margin:0;padding:20px;color:#1a1a1a">
<div style="max-width:560px;margin:0 auto"><div style="font-weight:800;font-size:19px;margin-bottom:12px">${esc(subject)}</div>
${sec.map(([h, ls]) => `<div style="margin:14px 0 4px;font-weight:700;color:#a55a42">${esc(h)}</div>${ls.map(l => `<div style="font-size:14px;margin:2px 0${l.startsWith("  ") ? ";padding-left:14px;color:#555" : ""}">${esc(l.trim())}</div>`).join("")}`).join("")}
<a href="${esc(origin)}/owner" style="display:inline-block;margin-top:16px;background:#d97757;color:#fff;text-decoration:none;font-weight:700;padding:10px 16px;border-radius:10px">Open the owner page</a></div></body></html>`;
  return { subject, text, html };
}

export async function sendOwnerWeekly(env, db, origin, ms = Date.now(), { force = false } = {}) {
  if (!force && !inSendWindow(ms)) return { sent: false, why: "not the window" };
  const to = adminEmail(env);
  if (!to) return { sent: false, why: "no owner email" };
  const wk = weekKey(ms);
  const claim = await db.prepare("INSERT OR IGNORE INTO owner_reports (week, sent_at) VALUES (?, ?)").bind(wk, new Date(ms).toISOString()).run();
  if (!force && !(claim.meta && claim.meta.changes)) return { sent: false, why: "already sent this week" };
  const m = ownerWeeklyEmail(await ownerStats(db, env, ms), origin);
  const r = await sendAlert(env, { to, ...m });
  return { sent: !!(r && r.sent), why: r && r.why, week: wk };
}

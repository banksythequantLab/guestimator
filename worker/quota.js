// Service limits (2026-10-07). When a paid service runs out - SoldComps' monthly sold-price
// allowance, Tavily's search quota, Nebius credits, eBay keys - estimates keep working on whatever
// is left (asking prices only, no web search), so nobody notices until prices drift. Every finished
// or failed estimate is checked here; the first hit per service per day emails the owner, and the
// owner page lists the last week's hits.
import { sendAlert } from "./notify.js";
import { adminEmail } from "./shipops.js";

export const SERVICES = [
  { key: "soldcomps", name: "SoldComps (sold prices)", re: /sold-price lookup allowance for this month is used up/i,
    fix: "Raise the plan or wait for the monthly reset at sold-comps.com. Until then estimates use asking prices only." },
  { key: "tavily", name: "Tavily (web search)", re: /market-search (quota is exhausted|key was rejected)/i,
    fix: "Top up or check the key at tavily.com. Until then estimates skip the web search." },
  { key: "ebay", name: "eBay API", re: /eBay rejected the API credentials|ebay auth (401|403)/i,
    fix: "Check the eBay developer keys. Until then there are no live eBay prices." },
  { key: "nebius", name: "Nebius (AI models)", re: /token factory (401|402|403|429)/i,
    fix: "Check credits and the API key at Nebius Token Factory. Estimates fail (and are refunded) until it's fixed." },
];

export function matchServices(texts) {
  const all = (texts || []).map(String);
  return SERVICES.filter(s => all.some(t => s.re.test(t)));
}

async function record(env, hits, text) {
  const db = env.DB, now = new Date().toISOString();
  for (const s of hits) {
    await db.prepare(`INSERT INTO service_alerts (service, message, first_seen, last_seen, hits) VALUES (?,?,?,?,1)
      ON CONFLICT(service) DO UPDATE SET message=excluded.message, last_seen=excluded.last_seen, hits=hits+1`)
      .bind(s.key, String(text).slice(0, 300), now, now).run();
    const row = await db.prepare("SELECT emailed_at FROM service_alerts WHERE service=?").bind(s.key).first();
    const last = row && row.emailed_at ? Date.parse(row.emailed_at) : 0;
    const to = adminEmail(env);
    if (to && Date.now() - last > 24 * 3600e3) {
      await sendAlert(env, { to, subject: `Guestimator: ${s.name} has hit its limit`,
        text: `${s.name} failed on a Guestimate just now:\n\n${String(text).slice(0, 300)}\n\nWhat to do: ${s.fix}\n\nYou'll get at most one of these a day per service. The owner page lists recent hits.` }).catch(() => null);
      await db.prepare("UPDATE service_alerts SET emailed_at=? WHERE service=?").bind(now, s.key).run();
    }
  }
}

// Never throws: this must not be able to break an estimate.
export async function checkResult(env, result) {
  try { const w = (result && result.warnings) || []; const hits = matchServices(w); if (hits.length) await record(env, hits, w.find(t => hits.some(s => s.re.test(t)))); } catch (e) { console.log("quota check failed", e && e.message); }
}
export async function checkError(env, message) {
  try { const hits = matchServices([message]); if (hits.length) await record(env, hits, message); } catch (e) { console.log("quota check failed", e && e.message); }
}

export async function recentAlerts(db, days = 7) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const rows = (await db.prepare("SELECT service, message, last_seen, hits, emailed_at FROM service_alerts WHERE last_seen>=? ORDER BY last_seen DESC").bind(since).all().catch(() => ({ results: [] }))).results || [];
  return rows.map(r => ({ ...r, name: (SERVICES.find(s => s.key === r.service) || {}).name || r.service, fix: (SERVICES.find(s => s.key === r.service) || {}).fix || "" }));
}
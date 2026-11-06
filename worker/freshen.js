// Keep the price guide current (2026-11-06). A published price page re-prices itself once its
// estimate is 30+ days old, a few a day, from the 15-minute cron. Only the guide owner's own opt-in
// pages (PRICE_REFRESH_OWNER), never anyone else's items. No credits are taken (funded_by
// "refresh"); the cost is the model and eBay calls. A refresh that comes back weaker than a page
// should show (thin, unsure, too few sales) does not replace the page: guideOf's query skips it.

export const REFRESH_DAYS = 30;
export const perDay = env => { const n = Number(env.PRICE_REFRESH_PER_DAY ?? 4); return Number.isFinite(n) && n > 0 ? Math.min(20, Math.floor(n)) : 0; };

/** SQL condition: a refresh run good enough to stand on a public page. `x` is the appraisals alias. */
export const GOOD_REFRESH = (x = "x") =>
  `(COALESCE(${x}.funded_by,'')<>'refresh' OR (COALESCE(json_extract(${x}.result_json,'$.thin_evidence'),0)=0 ` +
  `AND COALESCE(json_extract(${x}.result_json,'$.confidence'),0)>=0.7 AND COALESCE(json_extract(${x}.result_json,'$.sold_market.count'),0)>=2))`;

/** Starts at most one refresh per call, within the daily cap. Returns what it did, for the log. */
export async function freshenOne(env, db, now = new Date()) {
  const owner = String(env.PRICE_REFRESH_OWNER || "").trim().toLowerCase(), cap = perDay(env);
  if (!owner || !cap || !env.APPRAISALS) return { skipped: "off" };
  const dayStart = now.toISOString().slice(0, 10) + "T00:00:00.000Z";
  const today = await db.prepare("SELECT COUNT(*) AS n FROM appraisals WHERE funded_by='refresh' AND created_at>=?").bind(dayStart).first();
  if ((today?.n || 0) >= cap) return { skipped: "cap" };
  const busy = await db.prepare("SELECT COUNT(*) AS n FROM appraisals WHERE funded_by='refresh' AND status='pending'").first();
  if ((busy?.n || 0) > 0) return { skipped: "busy" };
  const cutoff = new Date(now.getTime() - REFRESH_DAYS * 86400e3).toISOString();
  const row = await db.prepare(
    `SELECT i.id, last.created_at AS at FROM items i JOIN sales s ON s.id=i.sale_id JOIN users u ON u.id=s.user_id
       JOIN appraisals last ON last.id=(SELECT id FROM appraisals x WHERE x.item_id=i.id AND x.status='done' ORDER BY x.created_at DESC LIMIT 1)
      WHERE lower(u.email)=? AND COALESCE(i.guide_public,0)=1 AND COALESCE(i.guide_hidden,0)=0 AND last.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM appraisals p WHERE p.item_id=i.id AND p.status='pending')
      ORDER BY last.created_at ASC LIMIT 1`).bind(owner, cutoff).first();
  if (!row) return { skipped: "none due" };
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO appraisals (id,item_id,status,created_at,funded_by) VALUES (?,?,'pending',?,'refresh')").bind(id, row.id, now.toISOString()).run();
  await env.APPRAISALS.send({ appraisalId: id, itemId: row.id });
  return { started: row.id, last: row.at };
}

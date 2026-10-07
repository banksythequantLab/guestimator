// Accuracy check (2026-10-07): what each Guestimate said against what the item actually sold
// for, with the seller's star rating. Sale prices come from eBay orders (minus shipping charged),
// paid Market/garage-sale orders, and items marked sold in person. Owner page only.

export function verdict(lo, hi, sold) {
  if (!(sold > 0) || !(hi > 0)) return { tag: "no estimate", ratio: null };
  const mid = (lo + hi) / 2, ratio = Math.round((sold / mid) * 100) / 100;
  if (sold < lo * 0.9) return { tag: "sold below range", ratio };
  if (sold > hi * 1.1) return { tag: "sold above range", ratio };
  return { tag: "in range", ratio };
}

export async function accuracyRows(db, limit = 40) {
  const rows = (await db.prepare(`
    WITH sold AS (
      -- per piece: one order of 7 sticks at $686 is $98 each, which is what the estimate priced
      SELECT item_id, (total_cents - COALESCE(ship_paid_cents, 0)) / MAX(COALESCE(quantity, 1), 1) AS cents, ordered_at AS at, 'eBay' AS via
        FROM ebay_orders WHERE status <> 'CANCELLED' AND item_id IS NOT NULL
      UNION ALL
      SELECT item_id, item_cents, updated_at, 'Market / sale page' FROM garage_orders
        WHERE status IN ('paid', 'fulfilled') AND item_id IS NOT NULL AND item_cents > 0
      UNION ALL
      SELECT item_id, price_cents, sold_at, 'in person' FROM garage_sale_items
        WHERE status = 'sold' AND price_cents > 0 AND sold_at IS NOT NULL
          AND item_id NOT IN (SELECT item_id FROM garage_orders WHERE status IN ('paid', 'fulfilled') AND item_id IS NOT NULL)
    )
    SELECT s.item_id, s.cents, s.at, s.via, i.ai_title, i.name,
      (SELECT a.result_json FROM appraisals a WHERE a.item_id = s.item_id AND a.status = 'done' ORDER BY a.created_at DESC LIMIT 1) AS rj,
      (SELECT r.stars FROM estimate_ratings r WHERE r.item_id = s.item_id ORDER BY r.updated_at DESC LIMIT 1) AS stars
    FROM sold s JOIN items i ON i.id = s.item_id ORDER BY s.at DESC LIMIT ?`).bind(limit).all()).results || [];
  return rows.map(r => {
    let pr = null, name = r.ai_title || r.name || "item";
    try { const j = JSON.parse(r.rj || "null"); pr = j && j.price_range; name = r.ai_title || (j && j.identification && j.identification.name) || name; } catch {}
    const lo = pr ? Number(pr.low) || 0 : 0, hi = pr ? Number(pr.high) || 0 : 0, sold = Number(r.cents || 0) / 100;
    return { item_id: r.item_id, name, at: r.at, via: r.via, sold, lo, hi, stars: r.stars == null ? null : Number(r.stars), ...verdict(lo, hi, sold) };
  });
}

export function summary(rows) {
  const priced = rows.filter(r => r.ratio != null);
  const inRange = priced.filter(r => r.tag === "in range").length;
  const sorted = priced.map(r => r.ratio).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  const rated = rows.filter(r => r.stars != null);
  return { sold: rows.length, priced: priced.length, inRange, median,
           avgStars: rated.length ? Math.round(10 * rated.reduce((a, r) => a + r.stars, 0) / rated.length) / 10 : null, rated: rated.length };
}
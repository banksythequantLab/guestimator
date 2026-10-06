// Guestimator Market (2026-10-06): one public page that lists every item for sale in every
// seller's Online shop, eBay-style (search, sort, buy it now), with no cut taken.
//
// A shop is a garage_sales row with kind='shop' (see garage.js), so buying, reserving, Stripe
// webhooks, order emails, packing slips, shipping labels, and profit/tax reports are the garage
// sale machinery unchanged. Money goes straight to the seller's own Stripe account (direct
// charge, no application fee). Only items a buyer can actually pay for right now are shown.
// /market?q=lamp&sort=new|low|high&page=2

import { page, esc, stripeReady } from "./garage.js";
import { siteOrigin } from "./site.js";

const money = c => "$" + (Number(c || 0) / 100).toFixed(2).replace(/\.00$/, "");
const PER_PAGE = 48;
const CHECKOUT_MINUTES = 30;
const SORTS = { new: "gi.added_at DESC", low: "price ASC, gi.added_at DESC", high: "price DESC, gi.added_at DESC" };

/** Normalised search params. */
export function marketParams(sp) {
  const q = String(sp.get("q") || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const sort = SORTS[sp.get("sort")] ? sp.get("sort") : "new";
  const pg = Math.min(200, Math.max(1, parseInt(sp.get("page"), 10) || 1));
  return { q, sort, page: pg };
}

/** SQL for one page of buyable shop items. Every search word must appear in the title or name. */
export function marketQuery({ q, sort, page: pg }) {
  const args = [];
  let where = `s.kind='shop' AND s.status='published' AND s.online_ok=1 AND gi.status='available'
    AND u.connect_account_id IS NOT NULL AND u.stripe_payouts_ready=1
    AND ((s.ship_ok=1 AND gi.ship_cents IS NOT NULL) OR s.pickup_ok=1)
    AND COALESCE(gi.online_price_cents, gi.price_cents) >= 100`;
  for (const w of (q ? q.split(" ") : []).slice(0, 6)) {
    const like = "%" + w.toLowerCase().replace(/[\\%_]/g, m => "\\" + m) + "%";
    where += ` AND (lower(COALESCE(i.ai_title,'')) LIKE ? ESCAPE '\\' OR lower(COALESCE(i.name,'')) LIKE ? ESCAPE '\\')`;
    args.push(like, like);
  }
  const sql = `SELECT gi.item_id, gi.ship_cents, gi.added_at, COALESCE(gi.online_price_cents, gi.price_cents) AS price,
      s.slug, s.title AS shop, s.city, s.state, s.ship_ok, s.pickup_ok, i.name, i.ai_title,
      (SELECT r2_key FROM photos p WHERE p.item_id=gi.item_id ORDER BY p.sort, p.created_at LIMIT 1) AS thumb_key
    FROM garage_sale_items gi JOIN garage_sales s ON s.id=gi.sale_id JOIN users u ON u.id=s.user_id JOIN items i ON i.id=gi.item_id
    WHERE ${where} ORDER BY ${SORTS[sort]} LIMIT ${PER_PAGE + 1} OFFSET ${(pg - 1) * PER_PAGE}`;
  return { sql, args };
}

// Abandoned checkouts in shops are released here too, so a missed webhook never hides an item
// from the Market (sale pages already do this for their own sale).
export async function releaseShopStale(db, ms = Date.now()) {
  const cutoff = new Date(ms - (CHECKOUT_MINUTES + 2) * 60000).toISOString(), t = new Date(ms).toISOString();
  const shops = "SELECT id FROM garage_sales WHERE kind='shop'";
  await db.prepare(`UPDATE garage_orders SET status='cancelled', note=COALESCE(note,'checkout expired'), updated_at=?
    WHERE status='pending' AND created_at<? AND sale_id IN (${shops})`).bind(t, cutoff).run();
  await db.prepare(`UPDATE garage_sale_items SET status='available' WHERE status='pending' AND sale_id IN (${shops}) AND NOT EXISTS
    (SELECT 1 FROM garage_orders o WHERE o.sale_id=garage_sale_items.sale_id AND o.item_id=garage_sale_items.item_id AND o.status='pending')`).run();
}

const shipText = r => r.ship_ok && r.ship_cents != null ? (r.ship_cents ? `+ ${money(r.ship_cents)} shipping` : "Free shipping") : "Local pickup only";

export async function marketPage(env, url) {
  const db = env.DB, origin = siteOrigin(env, url);
  const p = marketParams(url.searchParams);
  let rows = [];
  if (stripeReady(env)) {
    await releaseShopStale(db).catch(() => {});
    const { sql, args } = marketQuery(p);
    rows = (await db.prepare(sql).bind(...args).all()).results;
  }
  const more = rows.length > PER_PAGE;
  rows = rows.slice(0, PER_PAGE);
  const link = pg => `/market?${new URLSearchParams({ ...(p.q ? { q: p.q } : {}), ...(p.sort !== "new" ? { sort: p.sort } : {}), ...(pg > 1 ? { page: pg } : {}) })}`;
  const cards = rows.map(r => `<a class="card" href="/sale/${esc(r.slug)}/item/${esc(r.item_id)}">
<img src="${r.thumb_key ? "/p/" + esc(r.thumb_key) : ""}" alt="" loading="lazy"><div class="b"><div class="t">${esc(r.ai_title || r.name)}</div>
<div class="p">${esc(money(r.price))}</div><div class="muted" style="font-size:.8rem">${esc(shipText(r))}</div>
<div class="muted" style="font-size:.78rem">${esc(r.city)}, ${esc(r.state)}</div></div></a>`).join("");
  const opt = (k, label) => `<option value="${k}" ${p.sort === k ? "selected" : ""}>${label}</option>`;
  const empty = p.q ? `<p>Nothing matches “${esc(p.q)}” right now. <a href="/market">See everything</a>.</p>`
    : `<p>Nothing for sale yet. Be the first: it's free to list.</p>`;
  const body = `<header><div class="wrap"><div class="kind">Guestimator</div><h1><a href="/market">Guestimator Market</a></h1>
<div class="when">Things priced by Guestimator, sold by the people who own them. You pay the seller directly. We take no cut.</div></div></header>
<div class="wrap"><form method="get" action="/market" style="display:flex;gap:8px;margin:16px 0 0;flex-wrap:wrap">
<input name="q" value="${esc(p.q)}" placeholder="Search the Market" style="flex:1 1 220px"><select name="sort" style="width:auto" onchange="this.form.submit()">
${opt("new", "Newest")}${opt("low", "Price: low to high")}${opt("high", "Price: high to low")}</select><button class="btn" style="width:auto;margin:0">Search</button></form>
<div class="grid">${cards || empty}</div>
${p.page > 1 || more ? `<p style="display:flex;justify-content:space-between">${p.page > 1 ? `<a href="${esc(link(p.page - 1))}">← Previous</a>` : "<span></span>"}${more ? `<a href="${esc(link(p.page + 1))}">Next →</a>` : ""}</p>` : ""}
<div class="box"><b>Sell yours here, free.</b> Snap 3 photos, Guestimator prices it from what's actually selling, and it goes in your shop on the Market. No listing fees and no cut: buyers pay you through your own Stripe account (Stripe's card fee is the only cost).
<a class="btn" href="${esc(origin)}/?utm_source=market">Start selling</a></div></div>`;
  const title = p.q ? `${p.q} for sale · Guestimator Market` : "Guestimator Market · buy direct from sellers, no cut taken";
  return new Response(page({ title, desc: "Buy things priced by Guestimator directly from the people who own them. No marketplace cut.",
    image: rows[0]?.thumb_key ? `${origin}/p/${rows[0].thumb_key}` : null, canonical: `${origin}/market`, body }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

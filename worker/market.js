// Guestimator Market (2026-10-06): one public page that lists every item for sale in every
// seller's Online shop, eBay-style (search, sort, buy it now), with no cut taken.
//
// A shop is a garage_sales row with kind='shop' (see garage.js), so buying, reserving, Stripe
// webhooks, order emails, packing slips, shipping labels, and profit/tax reports are the garage
// sale machinery unchanged. Money goes straight to the seller's own Stripe account (direct
// charge, no application fee). Only items a buyer can actually pay for right now are shown.
// /market?q=lamp&sort=new|low|high&page=2

import { page, esc, stripeReady, cleanSale, newSlug, cents, ipHash } from "./garage.js";
import { questionAlert } from "./notify.js";
import { termsLive, TERMS_VERSION } from "./terms.js";
import { startingPrice } from "./ebay.js";
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
export function marketQuery({ q, sort, page: pg }, per = PER_PAGE) {
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
    WHERE ${where} ORDER BY ${SORTS[sort]} LIMIT ${per + 1} OFFSET ${(pg - 1) * per}`;
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

/** Sitemap entries: the Market and every item on it right now (item pages are canonical). */
export async function sitemapEntries(env, db) {
  const out = [{ loc: "/market" }];
  if (!stripeReady(env)) return out;
  const { sql, args } = marketQuery({ q: "", sort: "new", page: 1 }, 5000);
  for (const r of (await db.prepare(sql).bind(...args).all()).results) out.push({ loc: `/sale/${r.slug}/item/${r.item_id}`, mod: r.added_at });
  return out;
}

const shipText = r => r.ship_ok && r.ship_cents != null ? (r.ship_cents ? `+ ${money(r.ship_cents)} shipping` : "Free shipping") : "Local pickup only";

export async function marketPage(env, url) {
  const db = env.DB, origin = siteOrigin(env, url);
  const p = marketParams(url.searchParams);
  let rows = [];
  // Launch numbers for the owner page; a counting failure never breaks the page.
  await db.prepare("INSERT INTO market_views (day, views) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET views=views+1")
    .bind(new Date().toISOString().slice(0, 10)).run().catch(() => {});
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
${r.city ? `<div class="muted" style="font-size:.78rem">${esc(r.city)}, ${esc(r.state)}</div>` : ""}</div></a>`).join("");
  const opt = (k, label) => `<option value="${k}" ${p.sort === k ? "selected" : ""}>${label}</option>`;
  const empty = p.q ? `<p>Nothing matches “${esc(p.q)}” right now. <a href="/market">See everything</a>.</p>`
    : `<p>Nothing for sale yet. Be the first: it's free to list.</p>`;
  const body = `<header><div class="wrap"><div class="kind">Guestimator</div><h1><a href="/market">Guestimator Market</a></h1>
<div class="when">Things priced by Guestimator, sold by the people who own them. You pay the seller directly. We take no cut.</div></div></header>
<div class="wrap"><form method="get" action="/market" style="display:flex;gap:8px;margin:16px 0 0;flex-wrap:wrap">
<input name="q" value="${esc(p.q)}" placeholder="Search the Market" style="flex:1 1 220px"><select name="sort" style="width:auto" onchange="this.form.submit()">
${opt("new", "Newest")}${opt("low", "Price: low to high")}${opt("high", "Price: high to low")}</select><button class="btn" style="width:auto;margin:0">Search</button></form>
${cards ? `<div class="grid">${cards}</div>` : `<div style="margin:18px 0 30px">${empty}</div>`}
${p.page > 1 || more ? `<p style="display:flex;justify-content:space-between">${p.page > 1 ? `<a href="${esc(link(p.page - 1))}">← Previous</a>` : "<span></span>"}${more ? `<a href="${esc(link(p.page + 1))}">Next →</a>` : ""}</p>` : ""}
<div class="box"><b>Sell yours here, free.</b> Snap 3 photos, Guestimator prices it from what's actually selling, and it goes in your shop on the Market. No listing fees and no cut: buyers pay you through your own Stripe account (Stripe's card fee is the only cost).
<a class="btn" href="${esc(origin)}/?utm_source=market">Start selling</a></div>${termsLive(env) ? `<p class="muted"><a href="/market-terms">Market terms</a></p>` : ""}</div>`;
  const title = p.q ? `${p.q} for sale · Guestimator Market` : "Guestimator Market · buy direct from sellers, no cut taken";
  return new Response(page({ title, desc: "Buy things priced by Guestimator directly from the people who own them. No marketplace cut.",
    image: rows[0]?.thumb_key ? `${origin}/p/${rows[0].thumb_key}` : null, canonical: `${origin}/market`, body }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// ---------------------------------------------------------------- seller: one tap (/api/market/items/:itemId)
// "Sell on the Market" from a finished estimate: opens the seller's shop the first time (name,
// city, state), then puts this item in it at the estimate's price with a shipping price. Items in a
// shop are only shown to buyers once the seller's Stripe is ready (see marketQuery).

const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const nowIso = () => new Date().toISOString();
const myShop = (db, userId) => db.prepare("SELECT * FROM garage_sales WHERE user_id=? AND kind='shop' ORDER BY created_at LIMIT 1").bind(userId).first();
const zipOf = s => { try { const z = JSON.parse(s || "null")?.zip; return /^\d{5}/.test(String(z || "")) ? String(z).slice(0, 5) : null; } catch { return null; } };

export async function sellerApi(request, env, url, parts, userId) {
  const db = env.DB, m = request.method, origin = siteOrigin(env, url);
  const item = await db.prepare("SELECT i.* FROM items i JOIN sales s ON s.id=i.sale_id WHERE i.id=? AND s.user_id=?").bind(parts[3] || "", userId).first();
  if (!item) return J({ error: "Item not found" }, 404);
  let shop = await myShop(db, userId);
  const row = shop ? await db.prepare("SELECT * FROM garage_sale_items WHERE sale_id=? AND item_id=?").bind(shop.id, item.id).first() : null;
  const itemUrl = shop ? `${origin}/sale/${shop.slug}/item/${item.id}` : null;

  if (m === "GET") {
    const ap = await db.prepare("SELECT result_json FROM appraisals WHERE item_id=? AND status='done' ORDER BY created_at DESC LIMIT 1").bind(item.id).first();
    let result = null; try { result = JSON.parse(ap?.result_json || "null"); } catch {}
    const u = await db.prepare("SELECT shop_name, connect_account_id, stripe_payouts_ready FROM users WHERE id=?").bind(userId).first();
    const ss = await db.prepare("SELECT ship_from FROM seller_settings WHERE user_id=?").bind(userId).first().catch(() => null);
    const sp = startingPrice(result);
    return J({
      shop: shop ? { id: shop.id, title: shop.title, city: shop.city, state: shop.state, zip: shop.zip, pickup_ok: !!shop.pickup_ok, url: `${origin}/sale/${shop.slug}`, needs_setup: !shop.city } : null,
      listed: row ? { price_cents: row.online_price_cents ?? row.price_cents, ship_cents: row.ship_cents, status: row.status, url: itemUrl } : null,
      price_cents: sp ? Math.round(sp * 100) : (item.price_cents || null),
      shop_name: u?.shop_name || "", from_zip: shop?.zip || zipOf(ss?.ship_from),
      has_size: !!(result?.shipping && Array.isArray(result.shipping.box_in)),
      sold: item.listing_status === "sold",
      stripe: { platform_on: stripeReady(env), connected: !!u?.connect_account_id, ready: !!u?.stripe_payouts_ready },
      market_url: `${origin}/market`,
    });
  }

  if (m === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    if (item.listing_status === "sold") return J({ error: "This item is marked sold." }, 409);
    const price = cents(b.price), ship = cents(b.ship);
    if (Number.isNaN(price) || !(price >= 100)) return J({ error: "Enter a price of at least $1, like 25 or 7.50" }, 400);
    if (Number.isNaN(ship)) return J({ error: "Enter shipping like 12 or 8.50 (0 for free shipping)" }, 400);
    if (ship === null && !(shop && shop.pickup_ok)) return J({ error: "Enter a shipping price (0 for free shipping), so buyers can get it to them." }, 400);
    // Market terms: once they are live, a seller agrees once, the first time they list.
    if (termsLive(env)) {
      const ut = await db.prepare("SELECT market_terms_at FROM users WHERE id=?").bind(userId).first();
      if (!ut?.market_terms_at) {
        if (!b.agree_terms) return J({ error: "Please agree to the Guestimator Market terms first.", need_terms: true, terms_url: `${origin}/market-terms` }, 428);
        await db.prepare("UPDATE users SET market_terms_at=?, market_terms_version=? WHERE id=?").bind(nowIso(), TERMS_VERSION, userId).run();
      }
    }
    let newShop = false;
    if (!shop) {
      // No setup step (2026-10-06): the shop is made quietly, shipping only, named from the
      // account's shop name if it has one, located from the ship-from address if one is saved.
      // After the first listing the app offers to set up a proper shop page or a sale.
      const u = await db.prepare("SELECT shop_name FROM users WHERE id=?").bind(userId).first();
      const ss = await db.prepare("SELECT ship_from FROM seller_settings WHERE user_id=?").bind(userId).first().catch(() => null);
      let from = {}; try { from = JSON.parse(ss?.ship_from || "{}") || {}; } catch {}
      const title = String(u?.shop_name || "").trim().slice(0, 90) || "Guestimator seller";
      const loc = cleanSale({ kind: "shop", title, city: from.city || "", state: from.state || "" });
      const city = loc.ok ? loc.value.city : "", state = loc.ok ? loc.value.state : "";
      const zip = /^\d{5}/.test(String(from.zip || "")) ? String(from.zip).slice(0, 5) : null;
      const id = crypto.randomUUID(), t = nowIso();
      await db.prepare("INSERT INTO garage_sales (id,user_id,slug,kind,title,description,street,city,state,zip,starts_on,ends_on,hours,tz,status,pickup_ok,ship_ok,online_ok,contact_phone,created_at,updated_at) " +
        "VALUES (?,?,?,'shop',?,NULL,NULL,?,?,?,?,'9999-12-31',NULL,'America/New_York','published',0,1,1,NULL,?,?)")
        .bind(id, userId, newSlug(title), title, city, state, zip, t.slice(0, 10), t, t).run();
      shop = await myShop(db, userId);
      newShop = true;
    }
    if (row?.status === "pending") return J({ error: "Someone is paying for this right now. Try again in a few minutes." }, 409);
    if (row?.status === "sold") return J({ error: "This one already sold." }, 409);
    if (row) await db.prepare("UPDATE garage_sale_items SET price_cents=?, online_price_cents=NULL, ship_cents=?, status='available' WHERE sale_id=? AND item_id=?")
      .bind(price, ship, shop.id, item.id).run();
    else {
      const mx = await db.prepare("SELECT COALESCE(MAX(sort),0) AS s FROM garage_sale_items WHERE sale_id=?").bind(shop.id).first();
      await db.prepare("INSERT INTO garage_sale_items (sale_id,item_id,price_cents,online_price_cents,ship_cents,status,sort,added_at) VALUES (?,?,?,NULL,?,'available',?,?)")
        .bind(shop.id, item.id, price, ship, (mx.s || 0) + 1, nowIso()).run();
    }
    // One tap means it's on sale: a shop left in draft or ended earlier is opened again.
    if (shop.status !== "published" || !shop.online_ok || !shop.ship_ok)
      await db.prepare("UPDATE garage_sales SET status='published', online_ok=1, ship_ok=1, updated_at=? WHERE id=?").bind(nowIso(), shop.id).run();
    const u = await db.prepare("SELECT stripe_payouts_ready FROM users WHERE id=?").bind(userId).first();
    return J({ ok: true, url: `${origin}/sale/${shop.slug}/item/${item.id}`, visible: !!(stripeReady(env) && u?.stripe_payouts_ready),
                new_shop: newShop, shop_id: shop.id, needs_setup: !shop.city });
  }

  if (m === "DELETE") {
    if (!row) return J({ ok: true });
    if (row.status === "pending") return J({ error: "Someone is paying for this right now." }, 409);
    if (row.status === "sold") return J({ error: "It sold, so it stays as a record." }, 409);
    await db.prepare("DELETE FROM garage_sale_items WHERE sale_id=? AND item_id=?").bind(shop.id, item.id).run();
    return J({ ok: true });
  }
  return J({ error: "not found" }, 404);
}
// ---------------------------------------------------------------- buyer: "Ask the seller a question"
// POST /api/public/market/ask {sale, item, name, email, message}. Emailed to the seller with the
// buyer's email as reply-to. Limits: 5 per hour per visitor, 30 per day per shop.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export async function publicAsk(request, env, url, ctx) {
  const db = env.DB, origin = siteOrigin(env, url);
  let b = {}; try { b = await request.json(); } catch {}
  const sale = await db.prepare("SELECT * FROM garage_sales WHERE slug=? AND kind='shop' AND status='published'").bind(String(b.sale || "")).first();
  if (!sale) return J({ error: "This shop isn't open." }, 404);
  const row = await db.prepare("SELECT status FROM garage_sale_items WHERE sale_id=? AND item_id=?").bind(sale.id, String(b.item || "")).first();
  if (!row) return J({ error: "That item isn't in this shop any more." }, 404);
  if (row.status === "sold") return J({ error: "Sorry, that one has sold." }, 409);
  const name = String(b.name || "").trim().slice(0, 60), email = String(b.email || "").trim().slice(0, 120), message = String(b.message || "").trim().slice(0, 1000);
  if (!name || !EMAIL_RE.test(email) || message.length < 3) return J({ error: "Enter your name, a working email and your question." }, 400);
  const ih = await ipHash(request, env), hourAgo = new Date(Date.now() - 3600e3).toISOString(), dayAgo = new Date(Date.now() - 86400e3).toISOString();
  const lim = await db.prepare("SELECT (SELECT COUNT(*) FROM market_questions WHERE ip_hash=? AND created_at>?) mine, (SELECT COUNT(*) FROM market_questions WHERE sale_id=? AND created_at>?) shop")
    .bind(ih, hourAgo, sale.id, dayAgo).first();
  if (lim.mine >= 5 || lim.shop >= 30) return J({ error: "That's a lot of questions for now. Please try again later." }, 429);
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO market_questions (id,sale_id,item_id,name,email,message,ip_hash,emailed,created_at) VALUES (?,?,?,?,?,?,?,0,?)")
    .bind(id, sale.id, String(b.item), name, email, message, ih, nowIso()).run();
  const send = questionAlert(db, env, id, origin).then(r => r.sent ? db.prepare("UPDATE market_questions SET emailed=1 WHERE id=?").bind(id).run() : null)
    .catch(e => console.log("questionAlert", e));
  if (ctx && ctx.waitUntil) ctx.waitUntil(send); else await send;
  return J({ ok: true });
}
// ---------------------------------------------------------------- seller: put many items on at once
// GET  /api/market/bulk -> priced, unsold items not yet in the shop (newest first, up to 200)
// POST /api/market/bulk {items:[{id, price, ship}]} -> lists each through sellerApi, so the rules
//      (price >= $1, shipping required, quiet shop creation) are exactly the one-tap ones.
export async function bulkApi(request, env, url, userId) {
  const db = env.DB;
  if (request.method === "GET") {
    const rows = (await db.prepare(`SELECT i.id, COALESCE(i.ai_title, i.name) AS title,
        (SELECT r2_key FROM photos p WHERE p.item_id=i.id ORDER BY p.sort, p.created_at LIMIT 1) AS thumb_key,
        (SELECT result_json FROM appraisals a WHERE a.item_id=i.id AND a.status='done' ORDER BY a.created_at DESC LIMIT 1) AS rj
      FROM items i JOIN sales s ON s.id=i.sale_id
      WHERE s.user_id=? AND COALESCE(i.listing_status,'')<>'sold'
        AND NOT EXISTS (SELECT 1 FROM garage_sale_items gi JOIN garage_sales g ON g.id=gi.sale_id WHERE gi.item_id=i.id AND g.kind='shop')
      ORDER BY i.created_at DESC LIMIT 200`).bind(userId).all()).results;
    const items = [];
    for (const r of rows) {
      let res = null; try { res = JSON.parse(r.rj || "null"); } catch {}
      if (!res || res.unknown || res.needs_clarification) continue;
      const sp = startingPrice(res);
      if (!sp || sp < 1) continue;
      items.push({ id: r.id, title: r.title, thumb: r.thumb_key ? `/p/${r.thumb_key}` : null, price_cents: Math.round(sp * 100) });
    }
    return J({ items });
  }
  if (request.method === "POST") {
    let b = {}; try { b = await request.json(); } catch {}
    const list = (Array.isArray(b.items) ? b.items : []).slice(0, 200);
    if (!list.length) return J({ error: "Pick at least one item." }, 400);
    const done = [], failed = [];
    let newShop = false, shopId = null, visible = false;
    for (const it of list) {
      const req = new Request(url.toString(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ price: it.price, ship: it.ship, agree_terms: !!b.agree_terms }) });
      const r = await sellerApi(req, env, url, ["api", "market", "items", String(it.id || "")], userId);
      const j = await r.json().catch(() => ({}));
      if (r.status === 428) return J({ error: j.error, need_terms: true, terms_url: j.terms_url, listed: done.length }, 428);
      if (r.ok) { done.push(it.id); newShop = newShop || !!j.new_shop; shopId = j.shop_id || shopId; visible = !!j.visible; }
      else failed.push({ id: it.id, error: j.error || `error ${r.status}` });
    }
    return J({ listed: done.length, failed, new_shop: newShop, shop_id: shopId, visible });
  }
  return J({ error: "not found" }, 404);
}
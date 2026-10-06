// Public price-guide pages: /price/<slug>-<ebay listing id>, an index at /prices, /sitemap.xml and
// /robots.txt. Built only from items that are (or were) listed on eBay through Guestimator - so
// everything shown is already public on eBay - and never shows who the seller is, where they
// are, their photos, or comparable sellers' usernames. Each page ends with "Guestimate yours".

import { epn } from "./epn.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dollars = n => "$" + Math.round(Number(n)).toLocaleString("en-US");
const day = s => s ? String(s).slice(0, 10) : "";

export const slugify = s => String(s || "item").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70).replace(/-+$/, "") || "item";
export const pagePath = g => `/price/${slugify(g.title)}-${g.listing_id}`;

// Every eBay listing (one per item, newest) with a finished estimate. Sold-on-eBay counts too.
const BASE = `SELECT l.listing_id, l.listing_url, l.status, l.price_cents, l.sold_count, l.sold_median_cents, l.sold_checked_at, l.updated_at,
    COALESCE(i.ai_title, i.name) AS title, i.listing_status, a.result_json, a.created_at AS estimated_at,
    EXISTS (SELECT 1 FROM ebay_orders o WHERE o.listing_id=l.listing_id AND o.status<>'CANCELLED') AS sold_here
  FROM ebay_listings l JOIN items i ON i.id=l.item_id
  JOIN appraisals a ON a.id=(SELECT id FROM appraisals x WHERE x.item_id=l.item_id AND x.status='done' ORDER BY x.created_at DESC LIMIT 1)
  WHERE l.listing_id IS NOT NULL AND l.status<>'draft' AND l.status<>'error'
    AND l.created_at=(SELECT MAX(created_at) FROM ebay_listings y WHERE y.item_id=l.item_id AND y.listing_id IS NOT NULL)`;
const SHOWN = " AND COALESCE(i.guide_hidden,0)=0";

/** Turns a row into what a page may show. Nothing about the seller survives this. */
export function guideOf(row) {
  let r = {}; try { r = JSON.parse(row.result_json || "{}"); } catch {}
  const pr = r.price_range || {}, mk = r.market || {}, id = r.identification || {};
  const range = pr.low > 0 && pr.high > 0 ? { low: pr.low, high: pr.high } : mk.low > 0 && mk.high > 0 ? { low: mk.low, high: mk.high } : null;
  if (!range) return null;
  const comps = (Array.isArray(r.comparables) ? r.comparables : []).filter(c => c && c.title && Number(c.price) > 0).slice(0, 8)
    .map(c => ({ title: String(c.title).slice(0, 140), price: Number(c.price), condition: c.condition || null, sold: !!c.sold,
                 url: /^https:\/\/(www\.)?ebay\.com\/itm\//i.test(String(c.url || "")) ? String(c.url).split("?")[0] : null }));
  const live = row.status === "published" && row.listing_status !== "sold" && !row.sold_here;
  return {
    listing_id: String(row.listing_id), title: String(row.title || id.name || "Item").slice(0, 120),
    range, market: mk.count ? { count: mk.count, low: mk.low, high: mk.high, median: mk.median, as_of: mk.as_of } : null,
    sold: Number(row.sold_count) >= 3 && row.sold_median_cents ? { count: Number(row.sold_count), median: row.sold_median_cents / 100, as_of: row.sold_checked_at } : null,
    about: { maker: id.maker || null, category: id.category || null, period: id.period || null },
    comps, estimated_at: row.estimated_at, updated_at: row.updated_at || row.estimated_at,
    live: live ? { price: row.price_cents / 100, url: row.listing_url || `https://www.ebay.com/itm/${row.listing_id}` } : null,
    sold_on_ebay: !!row.sold_here,
  };
}

export async function allGuides(db, limit = 5000) {
  const { results } = await db.prepare(`${BASE}${SHOWN} ORDER BY l.updated_at DESC LIMIT ?`).bind(limit).all();
  return (results || []).map(guideOf).filter(Boolean);
}
export async function guideById(db, listingId) {
  const row = await db.prepare(`${BASE}${SHOWN} AND l.listing_id=?`).bind(String(listingId)).first();
  return row ? guideOf(row) : null;
}

/** For the seller's own item screen: is it on the price guide, hidden, or not eligible yet? */
export async function guideStatus(db, itemId, origin) {
  const row = await db.prepare(`${BASE} AND l.item_id=?`).bind(itemId).first();
  const hidden = !!(await db.prepare("SELECT guide_hidden FROM items WHERE id=?").bind(itemId).first())?.guide_hidden;
  const g = row ? guideOf(row) : null;
  return { eligible: !!g, hidden, url: g && !hidden ? origin + pagePath(g) : null };
}

export const CSS = `:root{--bg:#f4ecdc;--card:#fbf6ea;--ink:#241b10;--mut:#6a5b44;--line:#e0d2b4;--acc:#0f6b59}
@media (prefers-color-scheme:dark){:root{--bg:#17130d;--card:#221c14;--ink:#f1e7d3;--mut:#b3a387;--line:#3a3022;--acc:#5cc2a8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
.w{max-width:760px;margin:0 auto;padding:16px}header a{color:var(--acc);font-weight:800;text-decoration:none;font-family:Georgia,serif;font-size:1.2rem}
h1{font:700 1.7rem/1.2 Georgia,serif;margin:18px 0 6px}h2{font-size:1.05rem;margin:24px 0 8px}.m{color:var(--mut);font-size:.88rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:12px 0}
.big{font-size:2rem;font-weight:800;font-variant-numeric:tabular-nums}table{width:100%;border-collapse:collapse;font-size:.9rem}
td,th{padding:7px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:.75rem;color:var(--mut);text-transform:uppercase}
.r{text-align:right;white-space:nowrap}.cta{display:inline-block;background:var(--acc);color:#fff;font-weight:800;text-decoration:none;padding:12px 18px;border-radius:12px}
a{color:var(--acc)}ul.l{list-style:none;padding:0}ul.l li{padding:10px 0;border-bottom:1px solid var(--line)}`;

const shell = (title, desc, canonical, body, jsonld) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website"><meta property="og:url" content="${esc(canonical)}">
<link rel="icon" href="/icon.svg">${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>` : ""}
<style>${CSS}</style></head><body><div class="w"><header><a href="/prices">Guestimator price guide</a></header>${body}
<p class="m" style="margin-top:28px">Guestimates are market estimates from public eBay data at the date shown, not certified appraisals. Prices change; check before you buy or sell. As an eBay Partner, Guestimator may be paid a commission when you buy through links on this page.</p></div></body></html>`;

export function guidePage(g, origin) {
  const url = origin + pagePath(g), r = g.range;
  const title = `${g.title}: what it's worth (${dollars(r.low)}–${dollars(r.high)})`;
  const desc = `${g.title} is worth about ${dollars(r.low)}–${dollars(r.high)} based on ${g.sold ? `${g.sold.count} recent eBay sales` : g.market ? `${g.market.count} comparable eBay listings` : "current eBay listings"} (${day(g.estimated_at)}). Get a Guestimate of yours.`;
  const about = [g.about.maker && `Maker: ${g.about.maker}`, g.about.category && `Category: ${g.about.category}`, g.about.period && `Period: ${g.about.period}`].filter(Boolean);
  const jsonld = { "@context": "https://schema.org", "@type": "Product", name: g.title, ...(g.about.maker ? { brand: { "@type": "Brand", name: g.about.maker } } : {}),
    ...(g.live ? { offers: { "@type": "Offer", price: g.live.price.toFixed(2), priceCurrency: "USD", availability: "https://schema.org/InStock", url: g.live.url } } : {}) };
  const body = `<h1>${esc(g.title)}: what it's worth</h1><div class="m">Guestimated ${esc(day(g.estimated_at))}</div>
<div class="card"><div class="m">Guestimate</div><div class="big">${dollars(r.low)} – ${dollars(r.high)}</div>
${g.sold ? `<div style="margin-top:6px"><b>Recently sold on eBay:</b> median ${dollars(g.sold.median)} across ${g.sold.count} sales <span class="m">(checked ${esc(day(g.sold.as_of))})</span></div>` : ""}
${g.market ? `<div style="margin-top:4px"><b>Asking now:</b> ${dollars(g.market.low)}–${dollars(g.market.high)} across ${g.market.count} comparable listings, median ${dollars(g.market.median)}</div>` : ""}
${g.sold_on_ebay ? `<div style="margin-top:6px">✓ One of these sold on eBay through Guestimator.</div>` : ""}</div>
${g.live ? `<div class="card"><b>This one is for sale:</b> ${dollars(g.live.price)} on eBay. <a href="${esc(epn(g.live.url, "gs-guide"))}" rel="sponsored nofollow noopener" target="_blank">See the listing ↗</a></div>` : ""}
${about.length ? `<h2>About it</h2><div>${about.map(esc).join(" · ")}</div>` : ""}
${g.comps.length ? `<h2>Comparable listings we priced it against</h2><table><thead><tr><th>Listing</th><th>Condition</th><th class="r">Price</th></tr></thead><tbody>
${g.comps.map(c => `<tr><td>${c.url ? `<a href="${esc(epn(c.url, "gs-guide-comp"))}" rel="sponsored nofollow noopener" target="_blank">${esc(c.title)}</a>` : esc(c.title)}${c.sold ? " <b>(sold)</b>" : ""}</td><td>${esc(c.condition || "")}</td><td class="r">${dollars(c.price)}</td></tr>`).join("")}</tbody></table>` : ""}
<div class="card" style="margin-top:22px"><h2 style="margin-top:0">Have one to sell?</h2><p>Snap 2–4 photos and Guestimator prices yours from what's selling now, then lists it on your own eBay account. You check every word first.</p>
<a class="cta" href="/?utm_source=price_guide">Guestimate mine</a></div>`;
  return shell(title, desc, url, body, jsonld);
}

export function indexPage(guides, origin) {
  const body = `<h1>What's it worth? Price guide</h1><p class="m">Real items priced by Guestimator from current eBay data. ${guides.length} item${guides.length === 1 ? "" : "s"} so far.</p>
<ul class="l">${guides.map(g => `<li><a href="${esc(pagePath(g))}"><b>${esc(g.title)}</b></a><div class="m">${dollars(g.range.low)}–${dollars(g.range.high)} · ${esc(day(g.estimated_at))}</div></li>`).join("") || `<li class="m">Nothing here yet.</li>`}</ul>
<div class="card"><a class="cta" href="/?utm_source=price_guide">Guestimate something</a></div>`;
  return shell("Price guide: what's it worth? | Guestimator", "What things are actually worth, priced from current eBay listings and sales.", origin + "/prices", body, null);
}

export function sitemap(guides, origin) {
  const u = (loc, mod) => `<url><loc>${esc(origin + loc)}</loc>${mod ? `<lastmod>${esc(day(mod))}</lastmod>` : ""}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${u("/prices", guides[0]?.updated_at)}${guides.map(g => u(pagePath(g), g.updated_at)).join("")}</urlset>`;
}

export const robots = origin => `User-agent: *\nDisallow: /api/\nDisallow: /owner\nDisallow: /stickers\nDisallow: /tax-summary\nDisallow: /shippo/\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;

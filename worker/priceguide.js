// Public price-guide pages: /price/<slug>-<ebay listing id>, an index at /prices, /sitemap.xml and
// /robots.txt. Built only from items that are (or were) listed on eBay through Guestimator - so
// everything shown is already public on eBay - and never shows who the seller is, where they
// are, their photos, or comparable sellers' usernames. Each page ends with "Guestimate yours".

import { epn } from "./epn.js";
import { GOOD_REFRESH } from "./freshen.js";

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
  JOIN appraisals a ON a.id=(SELECT id FROM appraisals x WHERE x.item_id=l.item_id AND x.status='done' AND ${GOOD_REFRESH("x")} ORDER BY x.created_at DESC LIMIT 1)
  WHERE l.listing_id IS NOT NULL AND l.status<>'draft' AND l.status<>'error'
    AND l.created_at=(SELECT MAX(created_at) FROM ebay_listings y WHERE y.item_id=l.item_id AND y.listing_id IS NOT NULL)`;
const SHOWN = " AND COALESCE(i.guide_hidden,0)=0";
// Opted in (2026-10-08): a finished Guestimate the seller chose to publish without an eBay listing.
// Same page, same rules - no photos, no seller, no location - keyed "g" + 12 hex of the item id.
export const optKey = itemId => "g" + String(itemId || "").replace(/[^0-9a-f]/gi, "").slice(0, 12).toLowerCase();
const OPT = `SELECT 'g' || lower(substr(replace(i.id,'-',''),1,12)) AS listing_id, NULL AS listing_url, 'optin' AS status, NULL AS price_cents,
    NULL AS sold_count, NULL AS sold_median_cents, NULL AS sold_checked_at, a.created_at AS updated_at,
    COALESCE(i.ai_title, i.name) AS title, i.listing_status, a.result_json, a.created_at AS estimated_at, 0 AS sold_here
  FROM items i JOIN appraisals a ON a.id=(SELECT id FROM appraisals x WHERE x.item_id=i.id AND x.status='done' AND ${GOOD_REFRESH("x")} ORDER BY x.created_at DESC LIMIT 1)
  WHERE COALESCE(i.guide_public,0)=1 AND COALESCE(i.guide_hidden,0)=0
    AND NOT EXISTS (SELECT 1 FROM ebay_listings e WHERE e.item_id=i.id AND e.listing_id IS NOT NULL AND e.status<>'draft' AND e.status<>'error')`;

/** Turns a row into what a page may show. Nothing about the seller survives this. */
export function guideOf(row) {
  let r = {}; try { r = JSON.parse(row.result_json || "{}"); } catch {}
  const pr = r.price_range || {}, mk = r.market || {}, id = r.identification || {};
  const range = pr.low > 0 && pr.high > 0 ? { low: pr.low, high: pr.high } : mk.low > 0 && mk.high > 0 ? { low: mk.low, high: mk.high } : null;
  if (!range) return null;
  const comps = (Array.isArray(r.comparables) ? r.comparables : []).filter(c => c && c.title && Number(c.price) > 0).slice(0, 8)
    // SoldComps marks a sale by its source ("ebay.com (sold)"), not a sold flag (2026-10-12).
    .map(c => ({ title: String(c.title).slice(0, 140), price: Number(c.price), condition: c.condition || null, sold: !!c.sold || /\(sold\)/i.test(String(c.source || "")),
                 url: /^https:\/\/(www\.)?ebay\.com\/itm\//i.test(String(c.url || "")) ? String(c.url).split("?")[0] : null }));
  const live = row.status === "published" && row.listing_status !== "sold" && !row.sold_here;
  return {
    listing_id: String(row.listing_id), title: String(row.title || id.name || "Item").slice(0, 120),
    range, market: mk.count ? { count: mk.count, low: mk.low, high: mk.high, median: mk.median, as_of: mk.as_of } : null,
    // Sales: the listing's own sold check first, else the eBay sales the Guestimate itself was priced from.
    sold: Number(row.sold_count) >= 3 && row.sold_median_cents ? { count: Number(row.sold_count), median: row.sold_median_cents / 100, as_of: row.sold_checked_at }
      : r.sold_market && Number(r.sold_market.count) >= 2 && r.sold_market.median > 0 && comps.filter(c => c.sold).length >= 2 ? { count: Number(r.sold_market.count), median: Number(r.sold_market.median), as_of: r.sold_market.as_of || row.estimated_at } : null,
    about: { maker: id.maker || null, category: id.category || null, period: id.period || null },
    comps, estimated_at: row.estimated_at, updated_at: row.updated_at || row.estimated_at,
    live: live ? { price: row.price_cents / 100, url: row.listing_url || `https://www.ebay.com/itm/${row.listing_id}` } : null,
    sold_on_ebay: !!row.sold_here,
    // For picking landing examples: how sure the identification was, and whether the comparables
    // span "too wide to be one product" (2026-10-12: a hand-painted cabinet priced from two
    // mass-market bathroom cabinets that sold).
    confidence: Number(r.confidence) > 0 ? Number(r.confidence) : null,
    wide: (Array.isArray(r.warnings) ? r.warnings : []).some(x => /too wide to be one product/i.test(String(x))),
    // One comparable or none, and no sale: the public page says it's a rough guess, as the app does.
    thin: !!r.unknown || comps.length <= 1 && !comps.some(c => c.sold) && !(Number(row.sold_count) >= 3),
  };
}

export async function allGuides(db, limit = 5000) {
  const { results } = await db.prepare(`${BASE}${SHOWN} ORDER BY l.updated_at DESC LIMIT ?`).bind(limit).all();
  let opt = [];
  try { opt = (await db.prepare(`${OPT} ORDER BY a.created_at DESC LIMIT ?`).bind(limit).all()).results || []; } catch (e) { console.log("guide opt-in", e && e.message); }
  return [...(results || []), ...opt].map(guideOf).filter(Boolean)
    .sort((x, y) => String(y.updated_at || "").localeCompare(String(x.updated_at || ""))).slice(0, limit);
}
export async function guideById(db, listingId) {
  const id = String(listingId);
  if (/^g[0-9a-f]{12}$/.test(id)) {
    const row = await db.prepare(`${OPT} AND lower(substr(replace(i.id,'-',''),1,12))=?`).bind(id.slice(1)).first();
    return row ? guideOf(row) : null;
  }
  const row = await db.prepare(`${BASE}${SHOWN} AND l.listing_id=?`).bind(id).first();
  return row ? guideOf(row) : null;
}

/** For the seller's own item screen: is it on the price guide, hidden, or not eligible yet? */
export async function guideStatus(db, itemId, origin) {
  const row = await db.prepare(`${BASE} AND l.item_id=?`).bind(itemId).first();
  const hidden = !!(await db.prepare("SELECT guide_hidden FROM items WHERE id=?").bind(itemId).first())?.guide_hidden;
  const g = row ? guideOf(row) : null;
  if (g) return { eligible: true, hidden, url: !hidden ? origin + pagePath(g) : null, optin: { eligible: false, on: false } };
  // Not on eBay: the seller can still publish a finished Guestimate (opt-in, off by default).
  const it = await db.prepare("SELECT guide_public FROM items WHERE id=?").bind(itemId).first();
  const on = !!(it && it.guide_public);
  const ap = await db.prepare("SELECT result_json FROM appraisals WHERE item_id=? AND status='done' ORDER BY created_at DESC LIMIT 1").bind(itemId).first();
  const og = ap ? guideOf({ listing_id: optKey(itemId), status: "optin", result_json: ap.result_json, title: "x" }) : null;
  const pg = on && !hidden && og ? await guideById(db, optKey(itemId)) : null;
  return { eligible: false, hidden, url: pg ? origin + pagePath(pg) : null, optin: { eligible: !!og, on } };
}

export const CSS = `:root{--bg:#ffffff;--card:#ffffff;--ink:#111111;--mut:#5a5a5a;--line:#e5e5e5;--acc:#a55a42;--btn:#d97757}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
.w{max-width:760px;margin:0 auto;padding:16px}header a{color:var(--btn);font-weight:800;text-decoration:none;font-family:Georgia,serif;font-size:1.2rem}
h1{font:700 1.7rem/1.2 Georgia,serif;margin:18px 0 6px}h2{font-size:1.05rem;margin:24px 0 8px}.m{color:var(--mut);font-size:.88rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:12px 0}
.big{font-size:2rem;font-weight:800;font-variant-numeric:tabular-nums}table{width:100%;border-collapse:collapse;font-size:.9rem}
td,th{padding:7px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:.75rem;color:var(--mut);text-transform:uppercase}
.r{text-align:right;white-space:nowrap}.cta{display:inline-block;background:var(--btn);color:#fff;font-weight:800;text-decoration:none;padding:12px 18px;border-radius:12px}
a{color:var(--acc)}ul.l{list-style:none;padding:0}ul.l li{padding:10px 0;border-bottom:1px solid var(--line)}`;

const shell = (title, desc, canonical, body, jsonld) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website"><meta property="og:url" content="${esc(canonical)}">
<link rel="icon" href="/icon.svg">${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c")}</script>` : ""}
<style>${CSS}</style></head><body><div class="w"><header><a href="/prices">Guestimator price guide</a></header>${body}
<p class="m" style="margin-top:28px">Guestimates are market estimates from public eBay data at the date shown, not certified appraisals. Prices change; check before you buy or sell. As an eBay Partner, Guestimator may be paid a commission when you buy through links on this page.</p></div></body></html>`;

export function guidePage(g, origin, more = []) {
  const url = origin + pagePath(g), r = g.range;
  // Google shows about 60 characters of a title; the price has to survive that (2026-10-12: the
  // SK hynix title was 97 and lost its price). The h1 keeps the full name.
  const name = g.title.length > 48 ? g.title.slice(0, 48).replace(/[\s,;:–-]+\S*$/, "") + "…" : g.title;
  const title = `${name} value: ${dollars(r.low)}–${dollars(r.high)}`;
  const desc = `${g.title} is worth about ${dollars(r.low)}–${dollars(r.high)} based on ${g.sold ? `${g.sold.count} recent eBay sales` : g.market ? `${g.market.count} comparable eBay listings` : "current eBay listings"} (${day(g.estimated_at)}). Get a Guestimate of yours.`;
  const about = [g.about.maker && `Maker: ${g.about.maker}`, g.about.category && `Category: ${g.about.category}`, g.about.period && `Period: ${g.about.period}`].filter(Boolean);
  // Product markup only with real offers: Google reports a Product with no offers, review or rating
  // as an invalid item in Search Console, and an estimate isn't an offer (2026-10-12).
  const offers = g.live ? { "@type": "Offer", price: g.live.price.toFixed(2), priceCurrency: "USD", availability: "https://schema.org/InStock", url: g.live.url }
    : g.market && g.market.low > 0 && g.market.high > 0 ? { "@type": "AggregateOffer", lowPrice: Number(g.market.low).toFixed(2), highPrice: Number(g.market.high).toFixed(2), offerCount: g.market.count, priceCurrency: "USD" } : null;
  const jsonld = offers ? { "@context": "https://schema.org", "@type": "Product", name: g.title, ...(g.about.maker ? { brand: { "@type": "Brand", name: g.about.maker } } : {}), offers } : null;
  // Breadcrumbs: Price guide > this item (helps search engines show where the page sits).
  const hub = hubOf(g);
  const crumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Price guide", item: origin + "/prices" },
    { "@type": "ListItem", position: 2, name: hub.name, item: origin + hubPath(hub) }, { "@type": "ListItem", position: 3, name: g.title, item: url }] };
  const faq = itemFaq(g, hub);
  // Same category first, then the newest of the rest.
  const others = more.filter(o => o.listing_id !== g.listing_id);
  more = [...others.filter(o => hubOf(o) === hub), ...others.filter(o => hubOf(o) !== hub)];
  const body = `<div class="m"><a href="/prices">Price guide</a> › <a href="${esc(hubPath(hub))}">${esc(hub.name)}</a></div><h1>${esc(g.title)}: what it's worth</h1><div class="m">Guestimated ${esc(day(g.estimated_at))}</div>
<div class="card"><div class="m">${g.thin ? "Guestimate · rough guess" : "Guestimate"}</div><div class="big">${dollars(r.low)} – ${dollars(r.high)}</div>
${g.thin ? `<div class="m" style="margin-top:4px">Few real sales to compare against (${g.comps.length ? "one comparable listing" : "none found"}), so treat this range as a rough guess.</div>` : ""}
${g.sold ? `<div style="margin-top:6px"><b>Recently sold on eBay:</b> median ${dollars(g.sold.median)} across ${g.sold.count} sales <span class="m">(checked ${esc(day(g.sold.as_of))})</span></div>` : ""}
${g.market ? `<div style="margin-top:4px"><b>Asking now:</b> ${dollars(g.market.low)}–${dollars(g.market.high)} across ${g.market.count} comparable listings, median ${dollars(g.market.median)}</div>` : ""}
${g.sold_on_ebay ? `<div style="margin-top:6px">✓ One of these sold on eBay through Guestimator.</div>` : ""}</div>
${g.live ? `<div class="card"><b>This one is for sale:</b> ${dollars(g.live.price)} on eBay. <a href="${esc(epn(g.live.url, "gs-guide"))}" rel="sponsored nofollow noopener" target="_blank">See the listing ↗</a></div>` : ""}
${about.length ? `<h2>About it</h2><div>${about.map(esc).join(" · ")}</div>` : ""}
${g.comps.length ? `<h2>Comparable listings we priced it against</h2><table><thead><tr><th>Listing</th><th>Condition</th><th class="r">Price</th></tr></thead><tbody>
${g.comps.map(c => `<tr><td>${c.url ? `<a href="${esc(epn(c.url, "gs-guide-comp"))}" rel="sponsored nofollow noopener" target="_blank">${esc(c.title)}</a>` : esc(c.title)}${c.sold ? " <b>(sold)</b>" : ""}</td><td>${esc(c.condition || "")}</td><td class="r">${dollars(c.price)}</td></tr>`).join("")}</tbody></table>` : ""}
${faq.length ? `<h2>Common questions</h2>${faq.map(q => `<h3 style="font-size:1rem;margin:14px 0 4px">${esc(q.q)}</h3><p style="margin:0">${esc(q.a)}</p>`).join("")}
<p class="m"><a href="${esc(hubPath(hub))}">More on ${esc(hub.name.toLowerCase())} prices</a></p>` : ""}
<div class="card" style="margin-top:22px"><h2 style="margin-top:0">Have one to sell?</h2><p>Snap 2–4 photos and Guestimator prices yours from what's selling now, then lists it on your own eBay account. You check every word first.</p>
<a class="cta" href="/?utm_source=price_guide">Guestimate mine</a></div>
${more.length ? `<h2>More ${esc(hub.name.toLowerCase())} and other prices</h2><p class="m"><a href="${esc(hubPath(hub))}">See all ${esc(hub.name.toLowerCase())}</a></p><ul class="l">${more.slice(0, 6).map(o => `<li><a href="${esc(pagePath(o))}">${esc(o.title)}</a><div class="m">${dollars(o.range.low)}–${dollars(o.range.high)}</div></li>`).join("")}</ul>` : ""}`;
  const faqLd = faq.length ? { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(q => ({ "@type": "Question", name: q.q, acceptedAnswer: { "@type": "Answer", text: q.a } })) } : null;
  return shell(title, desc, url, body, [jsonld, crumbs, faqLd].filter(Boolean));
}

export function indexPage(guides, origin) {
  const groups = hubsWith(guides);
  const body = `<h1>What's it worth? Price guide</h1><p class="m">Real items priced by Guestimator from current eBay data. ${guides.length} item${guides.length === 1 ? "" : "s"} so far.</p>
<div class="card"><b>Guides:</b> ${ARTICLES.map(a => `<a href="${esc(articlePath(a))}">${esc(a.title)}</a>`).join(" · ")}</div>
${groups.length ? `<div class="card"><b>Browse by category:</b> ${groups.map(x => `<a href="${esc(hubPath(x.hub))}">${esc(x.hub.name)}</a> <span class="m">(${x.guides.length})</span>`).join(" · ")}</div>` : ""}
${groups.map(x => `<h2><a href="${esc(hubPath(x.hub))}">${esc(x.hub.name)}</a></h2><ul class="l">${x.guides.map(itemLi).join("")}</ul>`).join("") || `<ul class="l"><li class="m">Nothing here yet.</li></ul>`}
<div class="card"><a class="cta" href="/?utm_source=price_guide">Guestimate something</a></div>`;
  return shell("Price guide: what's it worth? | Guestimator", "What things are actually worth, priced from current eBay listings and sales.", origin + "/prices", body, null);
}

export function sitemap(guides, origin, extra = []) {
  const u = (loc, mod) => `<url><loc>${esc(origin + loc)}</loc>${mod ? `<lastmod>${esc(day(mod))}</lastmod>` : ""}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${u("/prices", guides[0]?.updated_at)}${u("/how-it-works", "2026-11-06")}${ARTICLES.map(a => u(articlePath(a), guides[0]?.updated_at)).join("")}${hubsWith(guides).map(x => u(hubPath(x.hub), x.guides[0].updated_at)).join("")}${guides.map(g => u(pagePath(g), g.updated_at)).join("")}${extra.map(x => u(x.loc, x.mod)).join("")}</urlset>`;
}

// Category hubs (2026-11-06): /prices/<hub>. 83 pages sat on one flat list and Google had indexed
// one of them. Hubs give every page a second way in, a three-level breadcrumb, and "more like this"
// links to its own kind instead of whatever was published last. Order matters: first match wins.
export const HUBS = [
  { slug: "video-games", name: "Video games and consoles", blurb: "Game cartridges, consoles and handhelds: Nintendo, Game Boy, PlayStation, Sega, Xbox.",
    tips: ["Loose cartridge or disc vs. complete in box: the box and manual can add as much as the game itself, so say which you have.","Authentic vs. reproduction: popular titles are widely faked. Check the label print, the board inside, and the screws.","Region: a US game sells to US buyers. Japanese and PAL copies are a different market and usually sell for less here.","Tested and working, with a clean label, sells above \"untested\". Old save batteries in some games run dry, and buyers know it."],
    re: /\b(?:nintendo|game ?boy|gamecube|n64|snes|nes|wii|switch lite|3ds|ds lite|playstation|ps[1-5]|psp|xbox|sega|dreamcast|saturn|pok[eé]mon|video games?|game cartridge)\b/i },
  { slug: "film-cameras", name: "Film cameras", blurb: "35mm SLRs, compacts, rangefinders, TLRs and instant cameras.",
    tips: ["Body only vs. with a lens: a working lens can be worth more than the body, so price them as what you actually have.","A working light meter and accurate shutter speeds are what serious buyers check first. \"Meter works\" in a listing adds real money.","Lens fungus, haze or separation lowers the price a lot. Look through it at a bright light.","Cosmetics matter less than function, but dents and brassing still move the price within the working range."],
    re: /\b(?:camera|tlr|rangefinder|polaroid)\b/i },
  { slug: "vintage-audio", name: "Vintage audio", blurb: "Stereo receivers, turntables and portable cassette and CD players.",
    tips: ["Fully working on every input, both channels, all lamps lit, is the baseline buyers expect at full price.","Serviced or recapped units sell for more. Scratchy controls, dead lamps or one weak channel sell for less.","Original knobs, faceplate and wood case condition matter: replacement parts and cracked veneer cut the price.","For turntables, the cartridge and stylus that come with it can change the price a lot. Say which one it has."],
    re: /\b(?:receiver|turntable|amplifier|walkman|discman|cassette (?:deck|player)|tape deck)\b/i },
  { slug: "sewing-machines", name: "Sewing machines", blurb: "Singer, Bernina and other vintage sewing machines.",
    tips: ["Runs smoothly with its foot pedal and power cord is the starting point; missing parts lower it.","The original case, manual and attachments add value, especially for collectible models like the Featherweight.","Rust, worn decals and frozen mechanisms cut the price; a recent service raises it.","Heavy machines cost a lot to ship, so local pickup prices often run lower than shipped sales."],
    re: /\bsewing machines?\b/i },
  { slug: "kitchen", name: "Kitchen and cookware", blurb: "Pyrex, Corning Ware, Fire-King, cast iron and stand mixers.",
    tips: ["For Pyrex and similar glass: the exact pattern and color, and how much the color has faded (dishwasher wear), drive the price.","Chips, cracks and crazing lower the value a lot. Complete sets sell for more than the bowls one at a time.","For cast iron: the maker's mark and logo style (a Griswold large block logo, for example) and the size number set the market.","A cast iron pan that sits flat, with no cracks or deep pitting, sells for the most. Wobble and cracks cut it hard."],
    re: /\b(?:pyrex|corning ?ware|fire-?king|jade-?ite|cast iron|skillet|dutch oven|le creuset|kitchenaid|stand mixer|casserole|mixing bowls?)\b/i },
  { slug: "watches", name: "Watches", blurb: "Mechanical, automatic and digital watches.",
    tips: ["Running and keeping time is the baseline. Not running, or \"for parts\", is a different, much lower market.","Original dial, hands and crown add value; replacement or aftermarket parts lower it, especially on collectible models.","Box, papers and a recent service raise the price. So does a bracelet or strap that came with the watch.","The exact reference number matters: two watches that look alike can sell for very different amounts."],
    re: /\b(?:watch|wristwatch)\b/i },
  { slug: "computer-parts", name: "Computer parts and electronics", blurb: "Server memory, graphics cards, calculators and music players.",
    tips: ["The exact part number decides the price: speed, capacity, ECC or registered, and generation all change it.","Tested and working with proof (a screenshot or test log) sells above \"pulled from a working system\".","Selling one stick vs. a matched kit or a lot changes the per-piece price. Price per piece and say how many.","Server parts move in bulk. Check that the comparables are the same configuration, not just the same brand."],
    re: /\b(?:ddr\d|dimm|rdimm|memory module|graphics card|gpu|optane|calculator|ipod)\b/i },
  { slug: "more", name: "More finds", blurb: "Art, collectibles, tools and everything else.",
    tips: ["A maker's mark, signature or label is the biggest single thing that moves the price. Photograph it close up.","Condition: chips, cracks, repairs and missing parts lower the price; original finish raises it.","Size and form matter. A miniature or a tabletop version of something is a different market from the full-size piece.","Where it came from (provenance) and any paperwork can add value for art and collectibles."], re: null },
];
export const hubOf = g => HUBS.find(h => h.re && h.re.test(String((g && g.title) || ""))) ||
  HUBS.find(h => h.re && h.re.test(String((g && g.about && g.about.category) || ""))) || HUBS[HUBS.length - 1];
/** Questions answered from this page's own numbers, so each page says something no other page does. */
export function itemFaq(g, hub = hubOf(g)) {
  const out = [], r = g.range, when = day(g.estimated_at);
  const basis = g.sold ? `, based on ${g.sold.count} recent eBay sales with a median of ${dollars(g.sold.median)}`
    : g.market ? `, based on ${g.market.count} comparable eBay listings` : "";
  out.push({ q: `How much is a ${g.title} worth?`,
    a: `About ${dollars(r.low)} to ${dollars(r.high)} as of ${when}${basis}.` +
       (g.market && g.market.count ? ` Similar ones are listed right now for ${dollars(g.market.low)} to ${dollars(g.market.high)}, but asking prices run higher than what things sell for.` : "") +
       (g.thin ? " Few real sales were found, so treat this as a rough guess." : "") });
  const sold = (g.comps || []).filter(c => c.sold).slice(0, 4);
  if (sold.length >= 2)
    out.push({ q: `What has a ${g.title} sold for recently?`,
      a: `Recent eBay sales: ${sold.map(c => `${dollars(c.price)} (${c.title.length > 70 ? c.title.slice(0, 70).replace(/\s+\S*$/, "") + "…" : c.title})`).join("; ")}.` });
  if ((hub.tips || []).length)
    out.push({ q: `What makes one worth more or less?`, a: hub.tips.slice(0, 3).join(" ") });
  return out;
}
export const hubBySlug = slug => HUBS.find(h => h.slug === String(slug || "")) || null;
export const hubPath = h => `/prices/${h.slug}`;
/** Hubs that have at least one page, with their pages, in HUBS order. */
export const hubsWith = guides => HUBS.map(h => ({ hub: h, guides: guides.filter(g => hubOf(g) === h) })).filter(x => x.guides.length);
const itemLi = g => `<li><a href="${esc(pagePath(g))}"><b>${esc(g.title)}</b></a><div class="m">${dollars(g.range.low)}–${dollars(g.range.high)} · ${esc(day(g.estimated_at))}</div></li>`;

export function hubPage(hub, guides, origin) {
  const mine = guides.filter(g => hubOf(g) === hub), others = hubsWith(guides).filter(x => x.hub !== hub);
  const url = origin + hubPath(hub);
  const crumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Price guide", item: origin + "/prices" }, { "@type": "ListItem", position: 2, name: hub.name, item: url }] };
  const list = { "@context": "https://schema.org", "@type": "ItemList", name: `${hub.name} prices`,
    itemListElement: mine.slice(0, 100).map((g, i) => ({ "@type": "ListItem", position: i + 1, url: origin + pagePath(g), name: g.title })) };
  const body = `<div class="m"><a href="/prices">Price guide</a> › ${esc(hub.name)}</div><h1>${esc(hub.name)}: what they're worth</h1>
${ARTICLES.filter(a => a.hub === hub.slug).map(a => `<p><a href="${esc(articlePath(a))}"><b>${esc(a.title)}</b></a></p>`).join("")}
<p>${esc(hub.blurb)} Each range is priced from recent eBay sales and current listings. ${mine.length} item${mine.length === 1 ? "" : "s"}.</p>
${(hub.tips || []).length ? `<div class="card"><h2 style="margin-top:0">What moves the price</h2><ul>${hub.tips.map(t => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
<ul class="l">${mine.map(itemLi).join("") || `<li class="m">Nothing here yet.</li>`}</ul>
<div class="card"><a class="cta" href="/?utm_source=price_guide_hub">Guestimate yours</a></div>
${others.length ? `<h2>Other categories</h2><ul class="l">${others.map(x => `<li><a href="${esc(hubPath(x.hub))}">${esc(x.hub.name)}</a> <span class="m">(${x.guides.length})</span></li>`).join("")}</ul>` : ""}`;
  return shell(`${hub.name} prices: what they sell for | Guestimator`, `${hub.blurb} Prices from recent eBay sales, ${mine.length} items.`, url, body, [crumbs, list]);
}


// Guides (2026-11-06): pages that answer what people actually search ("how much are my old video
// games worth"), built from the live price guide so the numbers move when prices refresh. Each one
// links into its category and the item pages it quotes.
export const ARTICLES = [
  { slug: "old-video-games-worth", hub: "video-games",
    title: "How much are my old video games worth?",
    desc: "What old Nintendo, Sega and PlayStation games and consoles actually sell for, from recent eBay sales, and how to check yours.",
    intro: "Most old games are worth less than the asking prices you see online, and a few are worth a lot more. The only numbers that matter are what copies actually sold for. Here is what the most common ones went for recently, and how to work out what yours is worth.",
    steps: ["Find the exact title and system on the label, and check it is a US copy (Japanese and European copies are a different market).",
            "Decide what you have: cartridge only, or complete with box and manual. Complete copies sell for a lot more.",
            "Test it if you can. \"Tested, works\" sells above \"untested\".",
            "Look up recent sold prices, not asking prices, or Guestimate it from a photo."] },
  { slug: "old-film-camera-worth", hub: "film-cameras",
    title: "What is my old film camera worth?",
    desc: "What common 35mm, rangefinder and point-and-shoot film cameras actually sell for, from recent eBay sales, and what moves the price.",
    intro: "Film cameras have come back, and some that sat in drawers for decades now sell for real money. Working condition matters more than looks. Here is what common models sold for recently, and how to tell where yours fits.",
    steps: ["Read the model name on the front or top plate, and check whether you have just the body or a lens too.",
            "Put in a battery if it takes one and see whether the meter responds. Fire the shutter at a few speeds.",
            "Hold the lens up to a light and look for haze, fungus or scratches.",
            "Compare with recent sold prices for the same model, body only or with a lens."] },
  { slug: "vintage-stereo-worth", hub: "vintage-audio",
    title: "What is my vintage stereo receiver or turntable worth?",
    desc: "What vintage receivers and turntables from Marantz, Pioneer, Kenwood and Technics actually sell for, from recent eBay sales.",
    intro: "Seventies and eighties receivers and turntables are in demand, and the right model in good working order can sell for hundreds. Here is what common models sold for recently, and what pushes one to the top or bottom of its range.",
    steps: ["Find the model number on the front panel or the back.",
            "Check every function: both channels, every input, the lamps, and the tuner. Note anything scratchy or dead.",
            "For a turntable, note which cartridge and stylus it has. A premium cartridge can be worth more than the deck.",
            "Compare with recent sold prices for working units of the same model."] },
  { slug: "cast-iron-skillet-worth", hub: "kitchen", match: /cast iron|skillet|dutch oven|griddle|griswold|wagner|le creuset/i,
    title: "What is my cast iron skillet worth?",
    desc: "What Griswold, Wagner and other vintage cast iron and kitchenware actually sell for, from recent eBay sales.",
    intro: "Old cast iron from makers like Griswold and Wagner often sells for far more than a new pan, and the size number and logo can change the price several times over. Here is what common pieces sold for recently.",
    steps: ["Turn it over: read the maker, the logo and the size number on the bottom.",
            "Set it on a flat surface. A pan that spins or rocks is warped, which lowers the price.",
            "Look for cracks (hold it up to a light) and deep pitting.",
            "Compare with recent sold prices for the same maker, logo and size."] },
];
export const articleBySlug = slug => ARTICLES.find(a => a.slug === String(slug || "")) || null;
export const articlePath = a => `/guides/${a.slug}`;
export function articlePage(a, guides, origin) {
  // An article can narrow its category (the cast iron guide quotes pans, not Pyrex bowls).
  const hub = hubBySlug(a.hub), mine = guides.filter(g => hubOf(g) === hub && !g.thin && (!a.match || a.match.test(g.title)));
  const top = [...mine].sort((x, y) => y.range.high - x.range.high).slice(0, 15);
  const asOf = mine.map(g => day(g.estimated_at)).sort().pop() || "";
  const url = origin + articlePath(a);
  const faq = [{ q: a.title, a: top.length ? `It depends on the exact model and condition. Recent eBay sales put common ones between ${dollars(Math.min(...mine.map(g => g.range.low)))} and ${dollars(Math.max(...mine.map(g => g.range.high)))}; for example, ${top.slice(0, 3).map(g => `${g.title} at ${dollars(g.range.low)}–${dollars(g.range.high)}`).join(", ")}.` : a.intro },
               { q: "What makes one worth more?", a: (hub.tips || []).slice(0, 3).join(" ") }];
  const ld = [{ "@context": "https://schema.org", "@type": "Article", headline: a.title, description: a.desc, dateModified: asOf || undefined, mainEntityOfPage: url,
                publisher: { "@type": "Organization", name: "Guestimator" } },
              { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
                { "@type": "ListItem", position: 1, name: "Price guide", item: origin + "/prices" }, { "@type": "ListItem", position: 2, name: a.title, item: url }] },
              { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(q => ({ "@type": "Question", name: q.q, acceptedAnswer: { "@type": "Answer", text: q.a } })) }];
  const body = `<div class="m"><a href="/prices">Price guide</a> › <a href="${esc(hubPath(hub))}">${esc(hub.name)}</a></div>
<h1>${esc(a.title)}</h1>${asOf ? `<div class="m">Prices from recent eBay sales, updated ${esc(asOf)}</div>` : ""}
<p>${esc(a.intro)}</p>
${top.length ? `<h2>What they sold for recently</h2><table><thead><tr><th>Item</th><th class="r">Sold range</th></tr></thead><tbody>
${top.map(g => `<tr><td><a href="${esc(pagePath(g))}">${esc(g.title)}</a></td><td class="r">${dollars(g.range.low)}–${dollars(g.range.high)}</td></tr>`).join("")}</tbody></table>
<p class="m">${mine.length} priced so far. <a href="${esc(hubPath(hub))}">See all ${esc(hub.name.toLowerCase())}</a>.</p>` : ""}
<h2>How to find out what yours is worth</h2><ol>${a.steps.map(s => `<li>${esc(s)}</li>`).join("")}</ol>
${(hub.tips || []).length ? `<h2>What moves the price</h2><ul>${hub.tips.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
<div class="card" style="margin-top:22px"><h2 style="margin-top:0">Price yours in a minute</h2><p>Snap a photo or type what it is, and Guestimator prices it from what actually sold. Free to try, no account needed.</p>
<a class="cta" href="/?utm_source=price_guide_article">Guestimate mine</a></div>`;
  return shell(`${a.title} | Guestimator`, a.desc, url, body, ld);
}

export const robots = origin => `User-agent: *\nDisallow: /api/\nDisallow: /owner\nDisallow: /stickers\nDisallow: /tax-summary\nDisallow: /shippo/\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;

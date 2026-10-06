// "Share your price" (2026-10-06): a public page for one finished estimate, made only when the
// seller taps Share. Shows the item's first photo, its name and the Guestimate range, and ends with
// "What's yours worth?" through the sharer's own invite link (so a friend who signs up counts as
// their referral). Never shows who the seller is, where they are, their eBay account, or their notes.
// /e/<token>  - the token is random and unguessable; the page is noindex.

import { CSS } from "./priceguide.js";
import { codeFor } from "./growth.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dollars = n => "$" + Math.round(Number(n)).toLocaleString("en-US");
const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
export const newToken = () => [...crypto.getRandomValues(new Uint8Array(10))].map(b => ALPHA[b % ALPHA.length]).join("");

/** What a share page may show, from a finished estimate. null when there is no price to share. */
export function shareable(result) {
  const r = result || {};
  if (r.unknown || r.needs_clarification) return null;
  const pr = r.price_range || {};
  if (!(Number(pr.low) > 0 && Number(pr.high) > 0)) return null;
  const id = r.identification || {};
  return {
    title: String((r.listing && r.listing.title) || id.name || "Item").slice(0, 120),
    low: Number(pr.low), high: Number(pr.high),
    suggested: Number(pr.suggested_retail) > 0 ? Number(pr.suggested_retail) : null,
    comps: (Array.isArray(r.comparables) ? r.comparables : []).filter(c => c && Number(c.price) > 0).length,
    sold: !!(r.sold_market && r.sold_market.count),
    maker: id.maker || null, period: id.period || null,
  };
}

/** The seller tapped Share: one link per estimate (tapping again returns the same one). */
export async function createShare(db, userId, itemId, ms = Date.now()) {
  const ap = await db.prepare("SELECT id, result_json FROM appraisals WHERE item_id=? AND status='done' ORDER BY created_at DESC LIMIT 1").bind(itemId).first();
  if (!ap) return { status: 409, error: "Get an estimate first." };
  let result = null; try { result = JSON.parse(ap.result_json || "null"); } catch {}
  if (!shareable(result)) return { status: 409, error: "This estimate doesn't have a price to share yet." };
  const had = await db.prepare("SELECT token FROM estimate_shares WHERE appraisal_id=? AND user_id=?").bind(ap.id, userId).first();
  if (had) return { status: 200, token: had.token };
  const token = newToken();
  await db.prepare("INSERT INTO estimate_shares (token,item_id,user_id,appraisal_id,created_at,views) VALUES (?,?,?,?,?,0)")
    .bind(token, itemId, userId, ap.id, new Date(ms).toISOString()).run();
  return { status: 200, token };
}

/** The public page. null when the token is unknown or the item is gone. */
export async function sharePage(db, token, origin) {
  const s = await db.prepare(`SELECT s.token, s.user_id, s.item_id, s.created_at, a.result_json,
      (SELECT r2_key FROM photos p WHERE p.item_id=s.item_id ORDER BY sort, created_at LIMIT 1) AS photo
    FROM estimate_shares s JOIN appraisals a ON a.id=s.appraisal_id JOIN items i ON i.id=s.item_id WHERE s.token=?`).bind(String(token)).first();
  if (!s) return null;
  let result = null; try { result = JSON.parse(s.result_json || "null"); } catch {}
  const g = shareable(result);
  if (!g) return null;
  await db.prepare("UPDATE estimate_shares SET views=views+1 WHERE token=?").bind(s.token).run();
  let invite = `${origin}/?utm_source=share`;
  try { invite = `${origin}/?ref=${encodeURIComponent(await codeFor(db, s.user_id))}&utm_source=share`; } catch {}
  const url = `${origin}/e/${s.token}`, img = s.photo ? `${origin}/p/${s.photo}` : `${origin}/icon.svg`;
  // On sale in the seller's shop on the Market (and buyable right now)? Then the page sells it too.
  const buy = await db.prepare(`SELECT g.slug, COALESCE(gi.online_price_cents, gi.price_cents) AS price FROM garage_sale_items gi JOIN garage_sales g ON g.id=gi.sale_id
      JOIN users u ON u.id=g.user_id WHERE gi.item_id=? AND g.kind='shop' AND g.status='published' AND g.online_ok=1 AND gi.status='available'
      AND u.stripe_payouts_ready=1 LIMIT 1`).bind(s.item_id).first().catch(() => null);
  const range = `${dollars(g.low)}–${dollars(g.high)}`;
  const title = `${g.title}: Guestimated at ${range}`;
  const desc = `Priced from ${g.sold ? "recent eBay sales and " : ""}${g.comps ? `${g.comps} comparable listings` : "what's selling now"}. What's yours worth? Snap 3 photos and find out free.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><meta name="robots" content="noindex">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website">
<meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(img)}"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/icon.svg"><style>${CSS}
.ph{width:100%;max-height:420px;object-fit:contain;border-radius:14px;background:var(--card);border:1px solid var(--line);display:block}</style></head>
<body><div class="w"><header><a href="${esc(origin)}/?utm_source=share">Guestimator</a></header>
${s.photo ? `<img class="ph" src="${esc(img)}" alt="${esc(g.title)}" style="margin-top:12px">` : ""}
<h1>${esc(g.title)}</h1>
<div class="card"><div class="m">Guestimate</div><div class="big">${esc(range)}</div>
${g.suggested ? `<div style="margin-top:4px">Suggested price: <b>${dollars(g.suggested)}</b></div>` : ""}
<div class="m" style="margin-top:6px">Priced from ${g.sold ? "recent eBay sales and " : ""}${g.comps ? `${g.comps} comparable listing${g.comps === 1 ? "" : "s"}` : "what's selling now"}${g.maker ? ` · ${esc(g.maker)}` : ""}${g.period ? ` · ${esc(g.period)}` : ""}</div></div>
${buy ? `<a class="cta" href="${esc(`${origin}/sale/${buy.slug}/item/${s.item_id}`)}" style="margin-top:14px">Buy this one · ${dollars(buy.price / 100)}</a>
<p class="m" style="margin-top:6px">Sold by its owner on the <a href="${esc(origin)}/market">Guestimator Market</a>. You pay the seller directly.</p>` : ""}
<div class="card" style="margin-top:22px"><h2 style="margin-top:0">What's yours worth?</h2>
<p>Snap 3 photos and Guestimator prices it from what's actually selling on eBay right now. Then one tap writes the listing on your own eBay account. You start with 5 free credits.</p>
<a class="cta" href="${esc(invite)}">Price mine free</a></div>
<p class="m" style="margin-top:28px">A Guestimate is a market estimate from public listings on the day it was made, not a certified appraisal.</p>
</div></body></html>`;
}

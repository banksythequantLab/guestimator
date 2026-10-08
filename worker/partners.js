// Partner referrals. Each partner is offered only where it fits the item, every link goes
// through /go/<partner> so the click is counted (referral_clicks), and every card in the app
// says Guestimator may earn a referral fee. With no affiliate id set the link is the partner's
// plain page: nothing is tracked by the network, the user still gets where they wanted to go.
//
//  - AptDeco (2026-10-07): big pieces - furniture, anything ~30"+ or 40 lb+. Pickup and delivery
//    nationwide. Awin advertiser 93197, flat $10 per approved new seller. Needs AWIN_AFFID.
//  - uShip (2026-10-08): the same big pieces, for a seller who found a buyer far away: carriers
//    bid to move it. Impact "uShip Performance Partnership" - revenue share on the first
//    completed shipment. Needs USHIP_LINK (the tracking link Impact gives you), else plain site.
//  - Decluttr (2026-10-08): phones, tablets, consoles, video games, CDs/DVDs, Lego - fixed
//    trade-in price, no listing. Awin advertiser 8053, same AWIN_AFFID as AptDeco.

export const APTDECO_MID = "93197";
export const APTDECO_SELL = "https://www.aptdeco.com/sell/new";
export const DECLUTTR_MID = "8053";
export const DECLUTTR_SELL = "https://www.decluttr.com/";
export const USHIP_HOME = "https://www.uship.com/";

const FURNITURE = /\b(furniture|cabinet|armoire|wardrobe|dresser|chest of drawers|sideboard|buffet|credenza|hutch|bookcase|bookshelf|shelving|desk|table|chair|sofa|couch|loveseat|settee|bench|ottoman|bed|headboard|nightstand|vanity|console|cupboard|bureau|rug|mirror|floor lamp)\b/i;

// What Decluttr actually buys. "console" alone is a furniture word (console table), so only
// game consoles count; "Pixel" and "Galaxy" only with their maker.
const TRADE_IN = /\b(iphone|ipad|ipod|apple watch|macbook|smartphone|cell ?phone|mobile phone|android phone|tablet|kindle|e-?reader|samsung galaxy|google pixel|nintendo|playstation|ps[2345]|xbox|game ?boy|games? console|video ?games?|dvds?|blu-?rays?|cds?|compact discs?|lego)\b/i;

export function isBigPiece(result) {
  if (!result || typeof result !== "object") return false;
  const id = result.identification || {};
  if (FURNITURE.test(`${id.name || ""} ${id.category || ""}`)) return true;
  const s = result.shipping || {};
  const dims = (Array.isArray(s.item_in) ? s.item_in : []).map(Number).filter(n => n > 0);
  return (dims.length && Math.max(...dims) >= 30) || Number(s.item_weight_lb) >= 40;
}

// Electronics/media Decluttr buys - never for something big, and not for high-value pieces,
// where a fixed trade-in price would be a bad deal next to a proper sale.
export function isTradeIn(result) {
  if (!result || typeof result !== "object" || isBigPiece(result)) return false;
  const id = result.identification || {};
  if (!TRADE_IN.test(`${id.name || ""} ${id.category || ""}`)) return false;
  const hi = Number((result.price_range || {}).high);
  return !(hi > 1500);
}

const awin = (env, mid, dest) => {
  const aff = String((env && env.AWIN_AFFID) || "").replace(/[^0-9]/g, "");
  return aff ? `https://www.awin1.com/cread.php?awinmid=${mid}&awinaffid=${aff}&ued=${encodeURIComponent(dest)}` : dest;
};
export const aptdecoLink = env => awin(env, APTDECO_MID, APTDECO_SELL);
export const decluttrLink = env => awin(env, DECLUTTR_MID, DECLUTTR_SELL);
export function ushipLink(env) {
  const l = String((env && env.USHIP_LINK) || "").trim();
  return /^https:\/\/[a-z0-9.-]+\//i.test(l) ? l : USHIP_HOME;
}

export const PARTNERS = { aptdeco: aptdecoLink, decluttr: decluttrLink, uship: ushipLink };

// GET /go/<partner>?item=<id>: count the click, then send them on.
export async function go(env, url, partner) {
  const link = Object.hasOwn(PARTNERS, partner) ? PARTNERS[partner] : null;
  if (!link) return new Response("Not found", { status: 404 });
  try {
    const item = String(url.searchParams.get("item") || "").slice(0, 64) || null;
    await env.DB.prepare("INSERT INTO referral_clicks (partner, item_id, at) VALUES (?, ?, ?)").bind(partner, item, new Date().toISOString()).run();
  } catch (e) { console.log("referral click", e && e.message); }
  return new Response(null, { status: 302, headers: { location: link(env), "cache-control": "no-store" } });
}
export const goAptdeco = (env, url) => go(env, url, "aptdeco");

export async function clicks30(db, partner = "aptdeco") {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  try { return (await db.prepare("SELECT COUNT(*) n FROM referral_clicks WHERE partner=? AND at>=?").bind(partner, since).first())?.n || 0; } catch { return 0; }
}
export async function allClicks30(db) {
  const out = {};
  for (const p of Object.keys(PARTNERS)) out[p] = await clicks30(db, p);
  return out;
}

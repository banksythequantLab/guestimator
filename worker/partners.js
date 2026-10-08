// Partner referrals (2026-10-07). Big pieces - furniture, anything ~30"+ or 40 lb+ - get an
// "or sell it on AptDeco" option: AptDeco does pickup and delivery for furniture nationwide.
// Through the Awin network AptDeco pays a flat $10 per new seller whose listing is approved and
// $10 per new buyer's purchase (30-day window). AWIN_AFFID unset -> plain link, nothing tracked
// by Awin. Clicks are counted here either way so the owner page can see whether anyone uses it.

export const APTDECO_MID = "93197";
export const APTDECO_SELL = "https://www.aptdeco.com/sell/new";

const FURNITURE = /\b(furniture|cabinet|armoire|wardrobe|dresser|chest of drawers|sideboard|buffet|credenza|hutch|bookcase|bookshelf|shelving|desk|table|chair|sofa|couch|loveseat|settee|bench|ottoman|bed|headboard|nightstand|vanity|console|cupboard|bureau|rug|mirror|floor lamp)\b/i;

export function isBigPiece(result) {
  if (!result || typeof result !== "object") return false;
  const id = result.identification || {};
  if (FURNITURE.test(`${id.name || ""} ${id.category || ""}`)) return true;
  const s = result.shipping || {};
  const dims = (Array.isArray(s.item_in) ? s.item_in : []).map(Number).filter(n => n > 0);
  return (dims.length && Math.max(...dims) >= 30) || Number(s.item_weight_lb) >= 40;
}

export function aptdecoLink(env) {
  const aff = String((env && env.AWIN_AFFID) || "").replace(/[^0-9]/g, "");
  return aff ? `https://www.awin1.com/cread.php?awinmid=${APTDECO_MID}&awinaffid=${aff}&ued=${encodeURIComponent(APTDECO_SELL)}` : APTDECO_SELL;
}

// GET /go/aptdeco?item=<id>: count the click, then send them on.
export async function goAptdeco(env, url) {
  try {
    const item = String(url.searchParams.get("item") || "").slice(0, 64) || null;
    await env.DB.prepare("INSERT INTO referral_clicks (partner, item_id, at) VALUES ('aptdeco', ?, ?)").bind(item, new Date().toISOString()).run();
  } catch (e) { console.log("referral click", e && e.message); }
  return new Response(null, { status: 302, headers: { location: aptdecoLink(env), "cache-control": "no-store" } });
}

export async function clicks30(db) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  try { return (await db.prepare("SELECT COUNT(*) n FROM referral_clicks WHERE partner='aptdeco' AND at>=?").bind(since).first())?.n || 0; } catch { return 0; }
}
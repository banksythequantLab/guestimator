// Price-guide visits (2026-11-09). The guide pages are plain server-rendered HTML with no app.js,
// so a visitor who lands on /prices, a hub, a guide or an item page from Google, Hacker News or a
// copied link was never counted - only tagged links into the app were. This counts the arrival on
// the server: the referring site's host name (or utm_source) and which kind of page, nothing else.
// No cookies, no IP, no full referring URL. Same-site clicks, unknown referrers and bots are skipped.
const clean = v => String(v || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40);
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|curl|wget|python|httpclient|headless|lighthouse|monitor/i;
export function guideKind(path) {
  if (path === "/prices") return "index";
  if (path.startsWith("/prices/")) return "hub";
  if (path.startsWith("/guides/")) return "article";
  if (path.startsWith("/price/")) return "item";
  return null;
}
/** What to record for this request, or null to record nothing. */
export function guideVisit(request, url) {
  const kind = guideKind(url.pathname);
  if (!kind) return null;
  if (BOT.test(request.headers.get("user-agent") || "")) return null;
  let src = clean(url.searchParams.get("utm_source"));
  if (!src) {
    try {
      const h = new URL(request.headers.get("referer") || "").hostname.replace(/^www\./, "");
      if (h && h !== url.hostname && !h.endsWith("theguestimator.com")) src = clean(h);
    } catch {}
  }
  if (!src) return null;
  return { src, camp: "guide", content: kind };
}
export async function logGuideVisit(env, request, url) {
  try {
    const v = guideVisit(request, url);
    if (!v) return;
    await env.DB.prepare("INSERT INTO landing_hits (src, camp, content, inapp, at, ev, sid) VALUES (?,?,?,?,?,?,?)")
      .bind(v.src, v.camp, v.content, 0, new Date().toISOString(), "land", null).run();
  } catch (e) { console.log("guide visit", e && e.message); }
}

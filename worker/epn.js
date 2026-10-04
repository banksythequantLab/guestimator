// eBay Partner Network tracking on links to eBay listings (server side; the app has the same
// helper in public/app.js). Params per eBay's "Creating an EPN Tracking Link" (US rotation id).
// Only ebay.com links are touched. Never used on a seller's own listing in their own screens.
export const EPN_CAMPID = "5339215150";

export function epn(url, where, campid = EPN_CAMPID) {
  try {
    const u = new URL(url);
    if (!/(^|\.)ebay\.com$/i.test(u.hostname) || !campid) return url;
    const p = { mkcid: "1", mkrid: "711-53200-19255-0", siteid: "0", campid, toolid: "10001", customid: where || "gs", mkevt: "1" };
    for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
    return u.toString();
  } catch { return url; }
}

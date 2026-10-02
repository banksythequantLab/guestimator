import { packageFor, flatRateFits } from "./packing.js";
// Live shipping quotes through Shippo, for the box and weight the appraisal estimated.
//
// A quote is needed before there is a buyer, so there is no destination address. Three are used
// instead - next door (the seller's own ZIP), mid-country, and the far coast - so the seller sees
// what shipping really costs across the range, and the suggested flat price is set to cover a
// typical buyer rather than the cheapest one. Quote addresses need only ZIP + country (Shippo:
// city/ZIP are required to BUY a label, optional to rate one).
//
// Money is never taken here; this only reads rates. Labels are bought by the seller, elsewhere.

const API = "https://api.goshippo.com/shipments/";
const MID = "64106";              // Kansas City, MO: roughly the middle of the country's zones
const EAST_FAR = "98101";         // Seattle - far from an East Coast seller
const WEST_FAR = "04101";         // Portland, ME - far from a West Coast / Mountain seller

export const zip5 = z => { const m = String(z || "").match(/\b(\d{5})\b/); return m ? m[1] : null; };
// ZIPs starting 0-4 are east of the Mississippi, give or take; the far point is across the country.
export const farZip = from => (Number(String(from)[0]) <= 4 ? EAST_FAR : WEST_FAR);

// Keep the services a small seller actually uses, cheapest per service.
const WANT = {
  usps_ground_advantage: "USPS Ground Advantage",
  usps_priority: "USPS Priority Mail",
  ups_ground: "UPS Ground",
  fedex_ground: "FedEx Ground",
  fedex_home_delivery: "FedEx Home Delivery",
};
export function pickRates(rates) {
  const best = {};
  for (const r of Array.isArray(rates) ? rates : []) {
    const tok = r && r.servicelevel && r.servicelevel.token;
    const amt = Number(r && r.amount);
    if (!WANT[tok] || !(amt > 0) || (r.currency && r.currency !== "USD")) continue;
    if (!best[tok] || amt < best[tok].amount) best[tok] = { service: WANT[tok], token: tok, amount: Math.round(amt * 100) / 100, days: r.estimated_days ?? null,
                                                            rate_id: r.object_id || null, provider: r.provider || null };
  }
  return best;
}

async function rate(env, fromZip, toZip, parcel) {
  const body = {
    address_from: { zip: fromZip, country: "US" },
    address_to: { zip: toZip, country: "US" },
    parcels: [parcel],
    async: false,
  };
  const r = await fetch(API, {
    method: "POST",
    headers: { authorization: `ShippoToken ${env.SHIPPO_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j && (j.detail || j.message)) || `Shippo ${r.status}`);
  return pickRates(j.rates);
}

/**
 * est = appraisal result.shipping ({ box_in:[L,W,H], packed_weight_lb }).
 * Returns { from, zones:[{label, zip, rates:{token:{service,amount,days}}}], suggested, basis }.
 */
export async function quoteShipping(env, fromZipRaw, est, service = "ground") {
  if (!env.SHIPPO_API_TOKEN) throw Object.assign(new Error("Shipping quotes aren't switched on yet."), { status: 503 });
  const from = zip5(fromZipRaw);
  if (!from) throw Object.assign(new Error("Enter the 5-digit ZIP you ship from."), { status: 400 });
  if (!est || !Array.isArray(est.box_in) || !(est.packed_weight_lb > 0))
    throw Object.assign(new Error("This item has no size and weight estimate yet. Tap 'Estimate weight & box size (free)' first."), { status: 409 });
  // Quote the stock box or mailer the seller will actually use, not the exact padded size.
  const pk = packageFor(est);
  const [L, W, H] = pk ? pk.box_in : est.box_in;
  const parcel = { length: String(L), width: String(W), height: String(H), distance_unit: "in",
                   weight: String(Math.max(0.1, (pk && pk.weight_lb) || est.packed_weight_lb)), mass_unit: "lb" };
  const spots = [
    { label: "Nearby", zip: from },
    { label: "Mid-country", zip: MID },
    { label: "Across the country", zip: farZip(from) },
  ];
  const zones = await Promise.all(spots.map(async s => ({ ...s, rates: await rate(env, from, s.zip, parcel) })));
  // USPS Flat Rate, when it fits: one price to any distance, so one quote (to the far zone) is enough.
  const flat_rate = (await Promise.all(flatRateFits(est).map(async f => {
    try {
      const r = await rate(env, from, farZip(from), { template: f.template, weight: String(f.weight_lb), mass_unit: "lb" });
      return r.usps_priority ? { name: f.name, template: f.template, amount: r.usps_priority.amount } : null;
    } catch { return null; }
  }))).filter(Boolean);
  return { from, parcel: { box_in: [L, W, H], weight_lb: Number(parcel.weight) }, package: pk, zones, flat_rate, ...suggest(zones, service) };
}

// The eBay listing ships one USPS service at one flat price (Ground Advantage unless the seller
// picks Priority), so the suggestion is what THAT service costs a mid-country buyer, rounded up to
// the next dollar. That covers most buyers and loses a little on the far coast - the zone table
// shows exactly how much. If the service isn't offered, fall back to the cheapest mid-country rate.
const SERVICE_TOKEN = { ground: "usps_ground_advantage", priority: "usps_priority" };
export function suggest(zones, service = "ground") {
  const mid = (zones || []).find(z => z.label === "Mid-country") || (zones || [])[0];
  if (!mid) return { suggested: null, basis: "No rates came back." };
  const want = mid.rates[SERVICE_TOKEN[service] || SERVICE_TOKEN.ground];
  const cheapest = Object.values(mid.rates).sort((a, b) => a.amount - b.amount)[0];
  const pick = want || cheapest;
  if (!pick) return { suggested: null, basis: "No rates came back for this box." };
  return {
    suggested: Math.ceil(pick.amount),
    suggested_service: pick.service,
    basis: `${pick.service} to a mid-country buyer, rounded up to the dollar`,
  };
}

// What to actually pack an item in. The estimate works out an exact padded box (item + 2" a side,
// 3" if fragile), but nobody has a 7x5x3 box: sellers have stock sizes and padded mailers. This
// picks the smallest stock box that holds the padded size, or a padded mailer for small, flat,
// non-fragile things (a RAM stick ships fine in a #0 mailer for less than a box costs to send).

// Common stock boxes, inches, largest side first. Sorted by volume so the first fit is the smallest.
export const BOXES = [[6, 4, 4], [9, 6, 3], [8, 6, 4], [10, 8, 4], [12, 9, 4], [10, 8, 6], [12, 9, 6], [14, 10, 6],
  [12, 12, 6], [12, 12, 8], [16, 12, 8], [14, 14, 10], [12, 12, 12], [18, 14, 10], [16, 16, 12], [20, 16, 12],
  [18, 18, 16], [24, 18, 12], [20, 20, 20], [24, 18, 18], [24, 24, 24]]
  .sort((a, b) => a[0] * a[1] * a[2] - b[0] * b[1] * b[2]);

// Padded (bubble) mailers: outside size, and the flat space inside (allowing for the bubble lining).
export const MAILERS = [
  { name: "#0 padded mailer (6×10)", inner: [8.5, 5], dims: [10, 6, 1] },
  { name: "#2 padded mailer (8.5×12)", inner: [10.5, 7.5], dims: [12, 8.5, 1.5] },
  { name: "#5 padded mailer (10.5×16)", inner: [14.5, 9.5], dims: [16, 10.5, 2] },
];

// The item's own size: stored by newer estimates; for older ones, worked back from the padded box
// (which rounds up, so it can overstate by up to an inch).
function itemDims(est) {
  if (Array.isArray(est.item_in) && est.item_in.length === 3 && est.item_in.every(n => Number(n) > 0))
    return est.item_in.map(Number).sort((a, b) => b - a);
  const pad = est.fragile ? 3 : 2;
  return est.box_in.map(Number).sort((a, b) => b - a).map(d => Math.max(0.5, d - 2 * pad));
}
const fits = (need, box) => need[0] <= box[0] && need[1] <= box[1] && need[2] <= box[2];

/**
 * est: an appraisal's shipping block ({ box_in, item_weight_lb, packed_weight_lb, fragile }).
 * Returns { kind: "mailer"|"box"|"custom", name, box_in, weight_lb } or null.
 */
export function packageFor(est) {
  if (!est || !Array.isArray(est.box_in) || est.box_in.length !== 3) return null;
  const padded = est.box_in.map(Number).sort((a, b) => b - a);
  if (padded.some(n => !(n > 0))) return null;
  const item = itemDims(est);
  const itemLb = Number(est.item_weight_lb) || 0;
  // Small, flat, sturdy and light (1 lb or under): a mailer. Heavier flat things - a GPU, a hard
  // drive - get a box: a mailer protects against scuffs, not against a 1.5 lb card being sat on.
  if (!est.fragile && item[2] <= 1.5 && itemLb > 0 && itemLb <= 1) {
    const m = MAILERS.find(x => item[0] <= x.inner[0] && item[1] <= x.inner[1]);
    if (m) return { kind: "mailer", name: m.name, box_in: m.dims, weight_lb: Math.round((itemLb + 0.15) * 10) / 10 };
  }
  const b = BOXES.find(x => fits(padded, x));
  const weight = Number(est.packed_weight_lb) || null;
  if (!b) return { kind: "custom", name: `custom ${padded.join("×")} in box`, box_in: padded, weight_lb: weight };
  // A bigger stock box weighs a little more than the exact one (about 0.35 lb per 1000 cu in).
  const extra = Math.max(0, (b[0] * b[1] * b[2] - padded[0] * padded[1] * padded[2]) * 0.00035);
  return { kind: "box", name: `${b.join("×")} in box`, box_in: b, weight_lb: weight ? Math.round((weight + extra) * 10) / 10 : null };
}
// ---------- USPS Flat Rate ----------
// One price to anywhere in the US, whatever it weighs (up to 70 lb). It wins for small, heavy
// things - coin rolls, tools, cast iron - and loses for light ones. Shippo rates these from the
// carrier template token. Inner sizes are USPS's, in inches.
export const FLAT_RATE = [
  { template: "USPS_FlatRateEnvelope", name: "Flat Rate Envelope", flat: [12.5, 9.5], maxThick: 0.75 },
  { template: "USPS_FlatRatePaddedEnvelope", name: "Padded Flat Rate Envelope", flat: [12.5, 9.5], maxThick: 1.5 },
  { template: "USPS_SmallFlatRateBox", name: "Small Flat Rate Box", inner: [8.625, 5.375, 1.625] },
  { template: "USPS_MediumFlatRateBox1", name: "Medium Flat Rate Box", inner: [11, 8.5, 5.5] },
  { template: "USPS_MediumFlatRateBox2", name: "Medium Flat Rate Box (side-loading)", inner: [13.625, 11.875, 3.375] },
  { template: "USPS_LargeFlatRateBox", name: "Large Flat Rate Box", inner: [12, 12, 5.5] },
];

/** The smallest Flat Rate envelope and the smallest Flat Rate box the item fits in (0-2 options). */
export function flatRateFits(est) {
  if (!est || !Array.isArray(est.box_in) || est.box_in.length !== 3) return [];
  const item = itemDims(est);
  const itemLb = Number(est.item_weight_lb) || 0;
  if (!(itemLb > 0) || itemLb > 70) return [];
  const out = [];
  if (!est.fragile) {
    const env = FLAT_RATE.find(f => f.flat && item[2] <= f.maxThick && item[0] + 1 <= f.flat[0] && item[1] + 1 <= f.flat[1]);
    if (env) out.push(env);
  }
  // Boxes: a snug fit is fine for sturdy things (a coin roll in a Small box); 2 in a side if fragile.
  const room = est.fragile ? 4 : 0.4;
  const need = item.map(d => d + room);
  const box = FLAT_RATE.filter(f => f.inner).find(f => need[0] <= f.inner[0] && need[1] <= f.inner[1] && need[2] <= f.inner[2]);
  if (box) out.push(box);
  return out.map(f => ({ template: f.template, name: f.name, weight_lb: Math.round((itemLb + (f.flat ? 0.1 : 0.4)) * 10) / 10 }));
}
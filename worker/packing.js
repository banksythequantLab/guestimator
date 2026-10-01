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

const fits = (need, box) => need[0] <= box[0] && need[1] <= box[1] && need[2] <= box[2];

/**
 * est: an appraisal's shipping block ({ box_in, item_weight_lb, packed_weight_lb, fragile }).
 * Returns { kind: "mailer"|"box"|"custom", name, box_in, weight_lb } or null.
 */
export function packageFor(est) {
  if (!est || !Array.isArray(est.box_in) || est.box_in.length !== 3) return null;
  const padded = est.box_in.map(Number).sort((a, b) => b - a);
  if (padded.some(n => !(n > 0))) return null;
  const pad = est.fragile ? 3 : 2;
  const item = padded.map(d => Math.max(0.5, d - 2 * pad));
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
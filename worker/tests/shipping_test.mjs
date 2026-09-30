// Run:  node worker/tests/shipping_test.mjs
// Weight and box size for shipping, from the model's estimate of the bare item.
import { shippingEstimate } from "../appraiser.js";

let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

// A 12x18 framed oil, ~4 lb, not glass-fronted: 2" padding a side.
let s = shippingEstimate({ item_weight_lb: 4, item_in: [18, 12, 2], fragile: false, basis: "framed oil" });
ok("box is item + 4 in each way", JSON.stringify(s.box_in) === "[22,16,6]", s);
ok("packed weight adds box and fill", s.packed_weight_lb > 4 && s.packed_weight_lb < 5.5, s);
ok("dim weight = L*W*H/139, rounded up", s.dim_weight_lb === Math.ceil(22 * 16 * 6 / 139), s);
ok("billable is the larger, whole pounds", s.billable_lb === Math.max(Math.ceil(s.packed_weight_lb), s.dim_weight_lb), s);

// Fragile gets 3" a side and heavier fill.
s = shippingEstimate({ item_weight_lb: 0.3, item_in: [4, 4, 3], fragile: true });
ok("fragile padding 3 in a side", JSON.stringify(s.box_in) === "[10,10,9]", s);
ok("fragile flag carried", s.fragile === true);
ok("light item still has packing weight", s.packed_weight_lb >= 0.6, s);

// Dimensions are sorted largest first whatever order the model gave.
s = shippingEstimate({ item_weight_lb: 2, item_in: [3, 10, 6] });
ok("dims sorted", JSON.stringify(s.box_in) === "[14,10,7]", s);

// Two dims only: treated as flat, 1" deep.
s = shippingEstimate({ item_weight_lb: 1, item_in: [11, 8.5] });
ok("two dims -> 1 in deep", s && s.box_in[2] === 5, s);

// A lot of 4 ships together, stacked on the thin side, and weighs four times as much.
s = shippingEstimate({ item_weight_lb: 1.5, item_in: [8, 2, 2] }, { count: 4 });
ok("lot weight multiplied", s.item_weight_lb === 6, s);
ok("lot stacked along the thin side", JSON.stringify(s.box_in) === "[12,12,6]", s);

// Garbage and zeros give nothing rather than a fake number.
ok("zeros -> null", shippingEstimate({ item_weight_lb: 0, item_in: [0, 0, 0] }) === null);
ok("missing -> null", shippingEstimate(undefined) === null && shippingEstimate({}) === null);
ok("one dim -> null", shippingEstimate({ item_weight_lb: 2, item_in: [5] }) === null);
ok("strings are read as numbers", shippingEstimate({ item_weight_lb: "3", item_in: ["10", "8", "4"], fragile: "true" }).fragile === true);
// Absurd values are clamped, not trusted.
s = shippingEstimate({ item_weight_lb: 9999, item_in: [500, 20, 20] });
ok("weight clamped to 150 lb", s.item_weight_lb === 150, s);
ok("length clamped to 108 in (+padding)", s.box_in[0] === 112, s);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

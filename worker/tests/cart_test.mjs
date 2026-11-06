// Run: node worker/tests/cart_test.mjs
// Turntables: sales with a premium phono cartridge are left out (2026-11-06).
import { cartFilter, PREMIUM_CART, TURNTABLE } from "../appraiser.js";
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log("FAIL " + n + (got !== undefined ? "\n   got " + JSON.stringify(got) : ""))); };
const deck = "Dual 1219 turntable, working, on base";
for (const t of ["1219 DUAl TURNTABLE & SHURE V15 TYPE III", "Technics SL-1200MK2 with Ortofon 2M Blue", "Pioneer PL-12D w/ Ortofon 2M Bronze cartridge",
  "Thorens TD-160 Sumiko Rainier", "Rega Planar 3 Nagaoka MP-110", "Technics SL-1200 Audio-Technica AT-OC9 cartridge", "Dual 1229 Shure M97xE",
  "Denon DP-300F with Denon DL-103", "Linn Sondek Goldring 1042", "Thorens TD-125 Grado Gold"])
  ok(`premium: ${t}`, PREMIUM_CART.test(t));
for (const t of ["Dual 1219 Turntable - Serviced, new belt", "Technics SL-1200MK2 with Ortofon OM5e", "Pioneer PL-12D with Audio-Technica AT91 cartridge",
  "Dual 1219 with Shure M91ED", "Technics SL-D2 Direct Drive Turntable w/ Grado Black", "Pioneer PL-12D Stereo Turntable with Shure cartridge"])
  ok(`basic kept: ${t}`, !PREMIUM_CART.test(t));
const hits = [{ title: "Beautiful DUAL 1219 Turntable - Serviced", price: 500 }, { title: "1219 DUAl TURNTABLE & SHURE V15 TY", price: 1550 }];
const f = cartFilter(deck, hits);
ok("drops the V15 sale for a plain deck", f.dropped === 1 && f.kept.length === 1 && f.kept[0].price === 500, f);
ok("dealer says V15 -> kept", cartFilter("Dual 1219 turntable with Shure V15 Type III", hits).dropped === 0);
ok("not a turntable -> untouched", cartFilter("Shure V15 cartridge", hits).dropped === 0);
ok("record player counts", TURNTABLE.test("vintage record player"));
ok("identified name counts (Dual 1219 + category Turntable)", cartFilter("Dual 1219 Turntables", hits).dropped === 1);
console.log(`cart: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

// Run: node worker/tests/thin_test.mjs
import { clampToComps } from "../appraiser.js";
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log("FAIL " + n + (got !== undefined ? "\n     got " + JSON.stringify(got) : ""))); };
const raw = { low: 70, high: 1850, suggested_retail: 900, floor: 60 };
let r = clampToComps(raw, [{ title: "Large Display Cabinet (Etsy)", price: 1850 }]);
ok("one asking price does not set the range (the cabinet case)", r.price === raw && r.note === null, r);
r = clampToComps(raw, [{ title: "sold one", price: 300, sold: true }]);
ok("one real sale still narrows it", r.price.low === 120 && r.price.high === 450 && /one listing/.test(r.note), r);
r = clampToComps(raw, [{ price: 200 }, { price: 300 }]);
ok("two comparables still clamp", r.price.low === 120 && r.price.high === 375, r);
console.log("thin_test: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;

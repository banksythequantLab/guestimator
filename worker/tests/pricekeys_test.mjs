// Run: node worker/tests/pricekeys_test.mjs
// Repricer answers with min/max instead of low/high (2026-11-06).
import { usablePrice } from "../appraiser.js";
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.log("FAIL " + n)); };
const a = usablePrice({ min: 23.99, max: 42.99 }, "USD");
ok("min/max accepted", a && a.low === 24 && a.high === 43);
const b = usablePrice({ low: 10, high: 20 }, "USD");
ok("low/high still works", b && b.low === 10 && b.high === 20);
const c = usablePrice({ low: 10, high: 20, min: 1, max: 999 }, "USD");
ok("low/high win over min/max", c && c.low === 10 && c.high === 20);
ok("all zero still unusable", usablePrice({ min: 0, max: 0 }, "USD") === null);
console.log(`pricekeys: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

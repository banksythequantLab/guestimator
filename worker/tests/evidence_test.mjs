// Run: node worker/tests/evidence_test.mjs  - sold-first pricing, backtested on the first real sales
import { anchorToEvidence } from "../appraiser.js";
import { verdict } from "../accuracy.js";
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log("FAIL " + n + (got !== undefined ? "\n     got " + JSON.stringify(got) : ""))); };
// Samsung 32GB RDIMM: range said $100-$248, two matching sales ($100, $106), sold for $98 and $100
let r = anchorToEvidence({ low: 100, high: 248, suggested_retail: 170, floor: 90 }, { sold: [100, 106], askMedian: 170, askCount: 4 });
ok("two sales set the range", r.price.low === 88 && r.price.high === 118 && r.price.suggested_retail === 103 && /2 actual eBay sales/.test(r.note), r);
ok("both real Samsung sales land in range", verdict(r.price.low, r.price.high, 98).tag === "in range" && verdict(r.price.low, r.price.high, 100).tag === "in range");
// SK Hynix 32GB x8: per-stick range $190-$260, no matching sales, 4 asks median $227; sold $99 a stick
r = anchorToEvidence({ low: 190, high: 260, suggested_retail: 227, floor: 170 }, { sold: [], askMedian: 227, askCount: 4 });
ok("asks only: capped at the median ask", r.price.low === 102 && r.price.high === 227 && /no completed sales matched/.test(r.note), r);
ok("the $99-a-stick lot ($792 for 8) is in range", verdict(r.price.low * 8, r.price.high * 8, 792).tag === "in range", [r.price.low * 8, r.price.high * 8]);
// SK Hynix 16GB: $60-$250, asks median $71; sold $60
r = anchorToEvidence({ low: 60, high: 250, suggested_retail: 120, floor: 50 }, { sold: [], askMedian: 71, askCount: 4 });
ok("16GB sale at $60 in range", verdict(r.price.low, r.price.high, 60).tag === "in range", r.price);
// leave alone: one sale only, too few asks, or a range already under the asks
ok("one sale does not set it", anchorToEvidence({ low: 100, high: 200 }, { sold: [150] }).note === null);
ok("two asks do not cap it", anchorToEvidence({ low: 100, high: 200 }, { askMedian: 120, askCount: 2 }).note === null);
ok("range already at or under the asks is kept", anchorToEvidence({ low: 50, high: 110 }, { askMedian: 120, askCount: 5 }).note === null);
// Best Offer sales (2026-10-09): flagged by mapSold; soldPrice is the asking price for those.
{
  const { mapSold } = await import("../appraiser.js");
  const ms = mapSold([{ title: "Oak cabinet", url: "u1", soldPrice: "300", shippingPrice: "40", bestOfferAccepted: true },
                      { title: "Oak cabinet", url: "u2", soldPrice: "150", shippingPrice: "0" }], "Oak cabinet");
  ok("best-offer sale flagged, plain sale not", ms.find(x => x.url === "u1").boa === true && ms.find(x => x.url === "u2").boa === false, ms);
  ok("shipping never added to the price", ms.find(x => x.url === "u1").price === 300, ms);
}
console.log("evidence_test: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;

// Run: node worker/tests/thin_test.mjs
// Kept comparables without a price, and sales marked only by source (2026-11-06).
import { isSoldComp, fillComp } from "../appraiser.js";
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log("FAIL " + n + (got !== undefined ? "\n   got " + JSON.stringify(got) : ""))); };
ok("source (sold) counts", isSoldComp({ source: "ebay.com (sold)" }));
ok("sold flag counts", isSoldComp({ sold: true }));
ok("asking listing doesn't", !isSoldComp({ source: "ebay.com" }) && !isSoldComp(null));
const hits = [{ title: "Diddy Kong Racing Nintendo 64 N64 Authentic Cleaned Tested Retro Kids Super Fun", price: 43, url: "https://www.ebay.com/itm/111?x=1", source: "ebay.com (sold)" },
              { title: "Other thing", price: 5, url: "https://www.ebay.com/itm/222" }];
let c = fillComp({ title: "Diddy Kong Racing Nintendo 64 N64 Authentic Cleaned Tested Retro Kids Super Fun" }, hits);
ok("price filled by title", c.price === 43 && c.url === "https://www.ebay.com/itm/111?x=1" && c.source === "ebay.com (sold)", c);
c = fillComp({ title: "renamed by the model", url: "https://www.ebay.com/itm/222" }, hits);
ok("price filled by url", c.price === 5, c);
c = fillComp({ title: "has a price", price: 10, url: "https://www.ebay.com/itm/222" }, hits);
ok("existing price kept", c.price === 10, c);
c = fillComp({ title: "nothing matches" }, hits);
ok("no match -> unchanged", c.price === undefined, c);
console.log(`thin: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

// Run:  node worker/tests/sold_test.mjs
// Sold prices from SoldComps, with SoldComps stubbed at fetch(): the request we send, how sales are
// read back and filtered, the fallbacks, and that the repricer is told these are sales. NOT proof
// that SoldComps returns this shape - that needs one live call with a real key.
import { ebaySold, mapSold, soldFailure, summarise, repricePrompt } from "../appraiser.js";

let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

const S = (title, price, extra = {}) => ({ itemId: String(Math.random()).slice(2, 12), url: `https://www.ebay.com/itm/${Math.floor(Math.random() * 1e11)}?nordt=true`, title,
  condition: "Pre-Owned", soldPrice: String(price), soldCurrency: "USD", shippingPrice: "5.00", endedAt: "2026-09-20", bestOfferAccepted: false, ...extra });

const m = mapSold([S("SK Hynix 32GB DDR4 2400 ECC RDIMM", 42), S("SK Hynix 32GB DDR3 1600 ECC", 20), S("junk", 0), S("SK Hynix 32GB DDR4 2400", 38, { soldCurrency: "GBP" })], "SK Hynix 32GB DDR4-2400 RDIMM");
ok("maps sold price, date, marks as sold", m[0].price === 42 && m[0].sold === true && m[0].sold_at === "2026-09-20" && /SOLD on eBay 2026-09-20/.test(m[0].note), m[0]);
ok("drops zero price, wrong generation, non-USD", m.length === 1, m.map(x => x.title));
ok("strips the nordt tracking suffix", !m[0].url.includes("nordt"));

let calls = [];
globalThis.fetch = async (u, init) => { calls.push({ u: String(u), auth: init.headers.authorization });
  return new Response(JSON.stringify({ items: [S("Red Wing 3 gallon crock", 120), S("Red Wing 3 gallon crock salt glaze", 95, { bestOfferAccepted: true })] }), { status: 200 }); };
ok("no key -> null, says why, no call", (await ebaySold({}, "red wing crock")) === null && /not switched on/.test(soldFailure()) && calls.length === 0);
let r = await ebaySold({ SOLDCOMPS_API_KEY: "sc_test" }, "Red Wing 3 gallon crock");
const u = new URL(calls[0].u);
ok("GET /v1/scrape with keyword, count and a 90-day window", u.origin + u.pathname === "https://api.sold-comps.com/v1/scrape" && u.searchParams.get("keyword") && u.searchParams.get("count") === "30" &&
   /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get("soldAfter")) && calls[0].auth === "Bearer sc_test", calls[0]);
ok("returns sales, best offer noted", r.length === 2 && /best offer accepted/.test(r[1].note));
const sm = summarise(r, "eBay sold, last 90 days");
ok("summary labelled as sold", sm.count === 2 && sm.low === 95 && sm.high === 120 && sm.source === "eBay sold, last 90 days");

globalThis.fetch = async () => new Response(JSON.stringify({ error: "quota_exceeded" }), { status: 429 });
ok("quota -> null with a plain reason", (await ebaySold({ SOLDCOMPS_API_KEY: "k" }, "x")) === null && /used up/.test(soldFailure()));
globalThis.fetch = async () => { throw new Error("network down"); };
ok("network failure -> null, not a throw", (await ebaySold({ SOLDCOMPS_API_KEY: "k" }, "x")) === null && /failed/.test(soldFailure()));

const p = repricePrompt({ ident: { name: "crock" }, condition: "Good", lotInfo: null, market: { count: 3, low: 150, high: 200, median: 175 }, hits: r, soldMarket: sm });
ok("repricer told sold prices are what buyers paid, and asking separately", /SOLD on eBay in the last 90 days: 2 sales, \$95-\$120/.test(p) && /ASKING prices/.test(p) && /"sold": true/.test(p));
ok("no sold data -> prompt unchanged", !/SOLD on eBay/.test(repricePrompt({ ident: {}, hits: [] })));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

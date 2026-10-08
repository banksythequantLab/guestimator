// Run:  node worker/tests/sold_test.mjs
// Sold prices from SoldComps, with SoldComps stubbed at fetch(): the request we send, how sales are
// read back and filtered, the fallbacks, and that the repricer is told these are sales. NOT proof
// that SoldComps returns this shape - that needs one live call with a real key.
import { ebaySold, mapSold, soldFailure, summarise, repricePrompt, clampToComps, dealerSized } from "../appraiser.js";

let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

const S = (title, price, extra = {}) => ({ itemId: String(Math.random()).slice(2, 12), url: `https://www.ebay.com/itm/${Math.floor(Math.random() * 1e11)}?nordt=true`, title,
  condition: "Pre-Owned", soldPrice: String(price), soldCurrency: "USD", shippingPrice: "5.00", endedAt: "2026-09-20", bestOfferAccepted: false, ...extra });

const kits = mapSold([S("64GB (32GBx2) SK Hynix DDR4-2400T RDIMM", 320), S("4x SK Hynix 32GB DDR4-2400 ECC RDIMM 128GB", 650), S("8 x Dimms -SK hynix (4x32GB) DDR4 PC4-2400T", 999),
  S("SK Hynix 2x32GB DDR4-2666 ECC RDIMM 2Rx4 PC4-21300R", 330),
  S("SK Hynix 32GB 2Rx4 PC4-2400 DDR4 ECC Registered", 159)], "SK Hynix 32GB DDR4 2400 RDIMM");
ok("multi-stick kits left out of a single-item sold price", kits.length === 1 && kits[0].price === 159, kits.map(k => k.title));
ok("a set is compared with sets", mapSold([S("Pair of brass candlesticks", 80)], "pair of brass candlesticks").length === 1);
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
ok("repricer told sold prices are what buyers paid, no unjudged sold range, asking separately", /SOLD on eBay in the last 90 days: 2 completed sales/.test(p) && !/\$95-\$120/.test(p) && /cite only the matching/.test(p) && /ASKING prices/.test(p) && /"sold": true/.test(p));
ok("no sold data -> prompt unchanged", !/SOLD on eBay/.test(repricePrompt({ ident: {}, hits: [] })));
// Painted cabinet, 2026-10-07: $12-$500 against kept comps of $36-$499, and tabletop cabinets kept for a 56-inch one.
ok("repricer is told the item's size", /Size of this item: about 56 x 29 x 20 inches/.test(repricePrompt({ ident: { name: "cabinet" }, hits: [], size: [56, 29, 20] })));
ok("no size -> no size line", !/Size of this item/.test(repricePrompt({ ident: {}, hits: [] })));
{ const cl = clampToComps({ low: 12, high: 500, suggested_retail: 100, floor: 10 }, [{ price: 36 }, { price: 68 }, { price: 100 }, { price: 499 }]);
  ok("range pulled up to 0.6x the cheapest kept comp", cl.price.low === 22 && cl.price.high === 500 && cl.price.floor === 10 && /narrowed from \$12-\$500/.test(cl.note), cl); }
{ const cl = clampToComps({ low: 40, high: 2000, suggested_retail: 1500, floor: 30 }, [{ price: 50 }, { price: 80 }]);
  ok("range pulled down to 1.25x the dearest kept comp", cl.price.high === 100 && cl.price.suggested_retail === 100, cl); }
ok("a range inside the comps is left alone", clampToComps({ low: 40, high: 90 }, [{ price: 50 }, { price: 80 }]).note === null);
{ const cl = clampToComps({ low: 100, high: 499, suggested_retail: 315, floor: 80 }, [{ price: 499, sold: true }]);   // a real sale; one asking price no longer clamps (thin_test)
  ok("one SOLD comp clamps loosely (0.4x-1.5x)", cl.price.low === 200 && cl.price.high === 499 && /one listing kept as comparable\./.test(cl.note), cl); }
ok("no comps, no clamp", clampToComps({ low: 1, high: 900 }, []).note === null);
{ const s = dealerSized({ item_weight_lb: 392, item_in: [108, 12, 12], fragile: false }, "Painted cabinet. Size: 56 x 59 x 29 inches. Weight: 80 lb.");
  ok("seller's size and weight replace the guess", s.item_weight_lb === 80 && s.item_in.join() === "59,56,29" && s.fragile === false && /seller/.test(s.basis), s); }
ok("no size box -> the guess stands", dealerSized({ item_weight_lb: 4 }, "a lamp").item_weight_lb === 4);
ok("weight alone is used", dealerSized({ item_weight_lb: 9, item_in: [10, 8, 6] }, "Lamp. Weight: 3.5 lb.").item_weight_lb === 3.5);

// Parallel rungs (2026-10-05). Each lookup takes 150ms here; the first two find nothing.
{
  const Q = "SK Hynix 32GB DDR4 2400 ECC RDIMM Server Memory Module";
  const seen = [], wait = ms => new Promise(r => setTimeout(r, ms));
  globalThis.fetch = async u => { const kw = new URL(String(u)).searchParams.get("keyword"); seen.push(kw); await wait(150);
    return new Response(JSON.stringify({ items: seen.indexOf(kw) === 2 ? [S("SK Hynix 32GB DDR4 2400 ECC RDIMM", 40)] : [] }), { status: 200 }); };
  const t0 = Date.now(), got = await ebaySold({ SOLDCOMPS_API_KEY: "k" }, Q), took = Date.now() - t0;
  ok("three rungs start together, not one after another", seen.length === 3 && took < 300, { rungs: seen.length, took });
  ok("and the third rung's sales come back", got && got.length === 1 && got[0].price === 40, got);
  // The exact search wins even when a looser one answers first.
  const order = [];
  globalThis.fetch = async u => { const kw = new URL(String(u)).searchParams.get("keyword"); order.push(kw); const i = order.length - 1;
    await wait(i === 0 ? 200 : 20);
    return new Response(JSON.stringify({ items: [S(`SK Hynix 32GB DDR4 2400 RDIMM rung${i}`, 50 + i)] }), { status: 200 }); };
  const best = await ebaySold({ SOLDCOMPS_API_KEY: "k" }, Q);
  ok("the most exact rung is used even when it is the slowest", best && best[0].price === 50, best && best.map(b => b.title));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

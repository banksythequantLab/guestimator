// Run:  node worker/tests/appraise_flow_test.mjs
// A WHOLE estimate through the real appraise(), with Token Factory, eBay, SoldComps and the metal
// feed stubbed at fetch(). The unit tests cover the pieces; this covers how they are wired: which
// pricing pass sets the price, which explanation is shown, which sales reach the sold line, and
// what happens when a model call fails. Four paths:
//   ok       repricer answers with a price          -> its price and its note
//   noprice  repricer answers without a price        -> cold pass prices it, repricer note dropped
//   fail     repricer returns no JSON at all         -> cold pass still prices it (was: memory price)
//   allfail  repricer fails and cold pass gives 0s   -> first-pass price stands, dealer is told
// It proves the wiring, NOT that the real models price well; that is what live runs are for.
import { appraise } from "../appraiser.js";

let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 900) : ""}`)); };
const jr = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const said = text => jr({ choices: [{ message: { content: typeof text === "string" ? text : JSON.stringify(text) } }] });

const NAME = "SK Hynix 32GB DDR4-2400 ECC RDIMM";
const SOLD = [
  ["SK Hynix 32GB 2Rx4 PC4-2400T RDIMM HMA84GR7MFR4N-UH", 126, "https://www.ebay.com/itm/101"],
  ["SK Hynix 32GB DDR4-2400 ECC REG RDIMM HMA84GR7MFR4N-UH", 159.99, "https://www.ebay.com/itm/102"],
  ["SKhynix 32GB 2Rx4 PC4-2400T RDIMM HMA84GR7MFR4N-UH", 189.95, "https://www.ebay.com/itm/103"],
  ["SK Hynix 2x32GB DDR4-2400 ECC RDIMM kit", 330, "https://www.ebay.com/itm/104"],      // a kit: filtered before the model
  ["SK Hynix 32GB DDR4-2400 ECC LRDIMM HMA84GL7AMR4N", 1100, "https://www.ebay.com/itm/105"], // wrong type: the model rejects it
];
const LIVE = [["SK Hynix 32GB PC4-2400T RDIMM HMA84GR7MFR4N-UH", 173], ["SK Hynix 32GB DDR4 2400 ECC RDIMM server", 185], ["SK Hynix 32GB DDR4-2400 RDIMM", 199],
  ["SK Hynix 32GB DDR4-2400 ECC RDIMM new sealed", 12450]];   // junk: the model never keeps it

let mode = "ok";
const seen = { reprice: [], cold: [], identify: 0 };
globalThis.fetch = async (u, init = {}) => {
  const url = new URL(String(u));
  if (url.hostname === "query2.finance.yahoo.com") return jr({}, 404);
  if (url.pathname.endsWith("/oauth2/token")) return jr({ access_token: "t", expires_in: 7200 });
  if (url.pathname.endsWith("/item_summary/search"))
    return jr({ itemSummaries: LIVE.map(([title, p], i) => ({ title, itemWebUrl: `https://www.ebay.com/itm/20${i}`, price: { value: String(p), currency: "USD" }, condition: "Used" })) });
  if (url.hostname === "api.sold-comps.com")
    return jr({ items: SOLD.map(([title, p, url]) => ({ title, url: url + "?nordt=true", soldPrice: String(p), soldCurrency: "USD", shippingPrice: "0", endedAt: "2026-09-20", condition: "Pre-Owned" })) });
  if (url.hostname === "api.tavily.com") return jr({ results: [] });
  if (url.pathname.endsWith("/chat/completions")) {
    const body = JSON.parse(init.body);
    const sys = body.messages[0].content, user = body.messages[body.messages.length - 1].content;
    if (/pricing an item against live comparable listings/.test(sys)) {
      seen.reprice.push(user);
      if (mode === "fail" || mode === "allfail") return said("I could not decide on a price for this one.");
      const kept = { comparables: SOLD.slice(0, 3).map(([title, price, url]) => ({ title, price, url, source: "ebay.com (sold)" })),
        rejected: [{ title: SOLD[4][0], why: "LRDIMM, not an RDIMM" }], basis_note: "REPRICER-NOTE matching sales $126-$190" };
      return said(mode === "noprice" ? kept : { ...kept, price_range: { low: 140, high: 180, suggested_retail: 160, floor: 130, currency: "USD", basis: "Three matching sales." } });
    }
    if (/setting a retail price/.test(sys)) {
      seen.cold.push(user);
      return said(mode === "allfail" ? { low: 0, high: 0 } : { low: 120, high: 169.95, suggested_retail: 150.15, floor: 110, currency: "USD", basis: "COLD-BASIS from sold comparables." });
    }
    if (/writing for an independent antique dealer/.test(sys)) {
      seen.identify++;
      // A memory price far below the market: the failure the cold pass exists to correct.
      return said({ identification: { name: NAME, category: "Computer memory", maker: "SK Hynix", origin: "", period: "", style: "" },
        confidence: 0.9, evidence: ["label reads HMA84GR7MFR4N-UH"], transcribed_text: [], price_range: { low: 30, high: 60, suggested_retail: 45, floor: 25, currency: "USD", basis: "MEMORY-BASIS" },
        listing: { title: NAME, description: "Server memory.", tags: [], condition_grade: "Very good" }, questions_for_dealer: [],
        shipping: { item_weight_lb: 0.1, item_in: [6, 2, 1], fragile: false, basis: "one stick" } });
    }
    return jr({ error: "unrouted model call: " + sys.slice(0, 60) }, 500);
  }
  return jr({ errors: [{ message: "unstubbed " + url }] }, 404);
};

const env = { NEBIUS_API_KEY: "k", EBAY_CLIENT_ID: "c", EBAY_CLIENT_SECRET: "s", SOLDCOMPS_API_KEY: "sc_test" };
const run = async m => { mode = m; seen.reprice = []; seen.cold = []; return appraise(env, { photos: [], description: "SK Hynix 32GB DDR4 2400 server RAM stick", markings: "HMA84GR7MFR4N-UH", currency: "USD" }); };
const W = r => (r.warnings || []).join(" | ");

// ---------- ok ----------
let r = await run("ok");
ok("ok: repricer's price stands", r.price_range.low === 140 && r.price_range.high === 180, r.price_range);
ok("ok: its note explains it", /REPRICER-NOTE/.test(r.price_range.basis) && !/MEMORY-BASIS/.test(r.price_range.basis), r.price_range.basis);
ok("ok: no cold pass", seen.cold.length === 0 && !/second pass/.test(W(r)), W(r));
ok("ok: sold line = the sales the model kept", r.sold_market && r.sold_market.count === 3 && r.sold_market.low === 126 && r.sold_market.high === 190, r.sold_market);
ok("ok: the kit never reached the model", !/2x32GB/.test(seen.reprice[0]), seen.reprice[0]);
ok("ok: sold listings are in front of the model, marked sold", /"sold": true/.test(seen.reprice[0]) && /HMA84GR7MFR4N-UH/.test(seen.reprice[0]));
ok("ok: no pre-judged sold range in the prompt", /completed sales are among/.test(seen.reprice[0]) && !/\$126-\$1100/.test(seen.reprice[0]), seen.reprice[0].slice(0, 600));
ok("ok: the rejected LRDIMM is recorded with its reason", (r.rejected_comparables || []).some(x => /LRDIMM/.test(x.title) && /RDIMM/.test(x.why)), r.rejected_comparables);

ok("ok: asking prices reach the model as a median, not a junk-ended range", /4 listed, median \$192/.test(seen.reprice[0]) && !/\$173-\$12450/.test(seen.reprice[0]), seen.reprice[0].slice(0, 700));
ok("ok: model kept only sales -> no unjudged asking line, no market warnings", r.market === null
  && !/two different markets|too wide to be one product|judged to be different items/.test(W(r)), { market: r.market, w: W(r) });

// ---------- noprice ----------
r = await run("noprice");
ok("noprice: cold pass sets the price", r.price_range.low === 120 && r.price_range.high === 170 && seen.cold.length === 1, r.price_range);
ok("noprice: prices from $20 up are whole dollars", r.price_range.high === 170 && r.price_range.suggested_retail === 150, r.price_range);
ok("noprice: dealer told which pass priced it", /second pass over the comparables/.test(W(r)), W(r));
ok("noprice: the discarded repricer note is NOT shown", !/REPRICER-NOTE/.test(r.price_range.basis) && /COLD-BASIS/.test(r.price_range.basis), r.price_range.basis);
ok("noprice: kept sales still drive the sold line", r.sold_market && r.sold_market.count === 3, r.sold_market);
ok("noprice: cold prompt has no unjudged sold range", !/Sold on eBay, last 90 days:/.test(seen.cold[0]) && /use only the ones that are this exact item/.test(seen.cold[0]), seen.cold[0].slice(0, 400));

// ---------- fail ----------
r = await run("fail");
ok("fail: repricer failure is reported", /comps re-pricing failed/.test(W(r)), W(r));
ok("fail: cold pass still prices it (not the $30-$60 memory)", r.price_range.low === 120 && r.price_range.high === 170 && seen.cold.length === 1, r.price_range);
ok("fail: explained by the pass that priced it", /COLD-BASIS/.test(r.price_range.basis) && !/MEMORY-BASIS/.test(r.price_range.basis), r.price_range.basis);

// ---------- allfail ----------
r = await run("allfail");
ok("allfail: first-pass price stands", r.price_range.low === 30 && r.price_range.high === 60, r.price_range);
ok("allfail: and the dealer is told to trust the comparables over it", /neither pricing pass returned a price/.test(W(r)), W(r));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
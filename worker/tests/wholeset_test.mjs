// Run:  node worker/tests/wholeset_test.mjs
// A dealer's "set of 4" where the market sells the complete set. Built from the Pyrex Spring
// Blossom 441-444 run of 2026-11-09: lot arithmetic priced one bowl x 4 = $180-$276 while five
// sales of the complete set sat at $43-$69, every one rejected by the repricer as "a set of four
// bowls, not a single piece". Two paths:
//   set    two or more completed sales of the same 4-piece set -> set priced from them, no multiply
//   nosets no set sales in the pool                              -> lot arithmetic as before
import { appraise } from "../appraiser.js";

let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 900) : ""}`)); };
const jr = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const said = text => jr({ choices: [{ message: { content: typeof text === "string" ? text : JSON.stringify(text) } }] });

const SINGLES = [
  ["Vintage Pyrex 442 Spring Blossom Green Crazy Daisy 1.5 Qt Cinderella Mixing Bowl", 43, "https://www.ebay.com/itm/201"],
  ["PYREX 442 Mixing BOWL ~ 1½ qt Cinderella ~ CRAZY DAISY ~ Spring Blossom Green", 69, "https://www.ebay.com/itm/202"],
  ["Vintage Pyrex 442 Spring Blossom Green Crazy Daisy 1.5 Qt Cinderella Mixing Bowl", 44.99, "https://www.ebay.com/itm/203"],
];
const SETS = [
  ["1972-78 Pyrex Spring Blossom Cinderella Mixing Bowl Set 441-444 Nice & Shiny !", 120, "https://www.ebay.com/itm/301"],
  ["4 Pyrex Spring Blossom Cinderella Mixing Bowls Crazy Daisy All Greens 441 To 444", 135, "https://www.ebay.com/itm/302"],
  ["Vintage Corning Pyrex Cinderella Mixing Bowls Set 4: Crazy Daisy Spring Blossom", 149.99, "https://www.ebay.com/itm/303"],
];

let mode = "set";
const seen = { reprice: [], cold: [] };
globalThis.fetch = async (u, init = {}) => {
  const url = new URL(String(u));
  if (url.hostname === "query2.finance.yahoo.com") return jr({}, 404);
  if (url.pathname.endsWith("/oauth2/token")) return jr({ access_token: "t", expires_in: 7200 });
  if (url.pathname.endsWith("/item_summary/search")) return jr({ itemSummaries: [] });
  if (url.hostname === "api.sold-comps.com") {
    const rows = mode === "set" ? [...SINGLES, ...SETS] : SINGLES;
    return jr({ items: rows.map(([title, p, url]) => ({ title, url, soldPrice: String(p), soldCurrency: "USD", shippingPrice: "0", endedAt: "2026-11-01", condition: "Pre-Owned" })) });
  }
  if (url.hostname === "api.tavily.com") return jr({ results: [] });
  if (url.pathname.endsWith("/chat/completions")) {
    const body = JSON.parse(init.body);
    const sys = body.messages[0].content, user = body.messages[body.messages.length - 1].content;
    if (/pricing an item against live comparable listings/.test(sys)) {
      seen.reprice.push(user);
      // The model keeps whatever it was shown and prices from it: a set price when shown sets,
      // a single-bowl price when shown singles.
      const sets = /WHOLE SET/.test(user);
      const pool = sets ? SETS : SINGLES;
      return said({ comparables: pool.map(([title, price, url]) => ({ title, price, url, source: "ebay.com (sold)" })), rejected: [],
        price_range: sets ? { low: 120, high: 150, suggested_retail: 135, floor: 110, currency: "USD", basis: "SET-NOTE three set sales." }
                          : { low: 43, high: 69, suggested_retail: 50, floor: 40, currency: "USD", basis: "SINGLE-NOTE three single sales." } });
    }
    if (/setting a retail price/.test(sys)) { seen.cold.push(user); return said({ low: 0, high: 0 }); }
    if (/writing for an independent antique dealer/.test(sys))
      return said({ identification: { name: "Pyrex Spring Blossom Green Cinderella mixing bowl", category: "Glassware", maker: "Corning Glass Works (Pyrex)", origin: "USA", period: "c. 1972-1979", style: "" },
        confidence: 0.85, evidence: [], transcribed_text: [], price_range: { low: 15, high: 25, suggested_retail: 20, floor: 12, currency: "USD", basis: "MEMORY-BASIS one bowl" },
        listing: { title: "Pyrex Spring Blossom bowl", description: "", tags: [], condition_grade: "Very good" }, questions_for_dealer: [],
        shipping: { item_weight_lb: 1.5, item_in: [9, 9, 4], fragile: true, basis: "one bowl" } });
    return jr({ error: "unrouted model call: " + sys.slice(0, 60) }, 500);
  }
  return jr({ errors: [{ message: "unstubbed " + url }] }, 404);
};

const env = { NEBIUS_API_KEY: "k", EBAY_CLIENT_ID: "c", EBAY_CLIENT_SECRET: "s", SOLDCOMPS_API_KEY: "sc_test" };
const run = async m => { mode = m; seen.reprice = []; seen.cold = []; return appraise(env, { photos: [], description: "Pyrex Spring Blossom Green Cinderella mixing bowl set of 4, 441 442 443 444, no chips", markings: "", currency: "USD" }); };
const W = r => (r.warnings || []).join(" | ");

// ---------- set: complete-set sales exist ----------
let r = await run("set");
ok("set: the dealer is told it was priced as a complete set", /priced as a complete set of 4: 3 completed sales/.test(W(r)), W(r));
ok("set: the repricer was told to price the whole set, not one piece", /WHOLE SET/.test(seen.reprice[0]) && !/ONE PIECE/.test(seen.reprice[0]), seen.reprice[0].slice(0, 500));
ok("set: only set listings reached the model", /441-444|Set 4:|441 To 444/.test(seen.reprice[0]) && !/1\.5 Qt/.test(seen.reprice[0]), seen.reprice[0].slice(0, 900));
ok("set: priced from the set sales, not one bowl x 4", r.price_range.low >= 110 && r.price_range.high <= 160, r.price_range);
ok("set: no 'per piece x 4' arithmetic in the basis", !/per piece/.test(r.price_range.basis), r.price_range.basis);
ok("set: the lot is reported as a whole set with per-piece figures by division", r.lot && r.lot.whole_set === true && r.lot.count === 4 && r.lot.unit_retail === Math.round(r.price_range.suggested_retail / 4), r.lot);
ok("set: sold line is the set sales", r.sold_market && r.sold_market.count === 3 && r.sold_market.low === 120, r.sold_market);
ok("set: no cold pass needed", seen.cold.length === 0, seen.cold.length);

// ---------- nosets: lot arithmetic still applies ----------
r = await run("nosets");
ok("nosets: not called a complete set", !/priced as a complete set/.test(W(r)), W(r));
ok("nosets: the repricer prices ONE PIECE", /ONE PIECE/.test(seen.reprice[0]) && !/WHOLE SET/.test(seen.reprice[0]));
ok("nosets: one bowl x 4", /per piece × 4/.test(r.price_range.basis) && r.lot && !r.lot.whole_set && r.lot.count === 4, { basis: r.price_range.basis, lot: r.lot });
ok("nosets: set total is four times the single-bowl sales", r.price_range.low >= 140 && r.price_range.high <= 300, r.price_range);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

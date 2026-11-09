// Run: node worker/tests/barehint_test.mjs
// Second sold search for loose copies (2026-11-09): only when the filtered sold pool is under two,
// only for a dealer who said loose (or console only), hinted with eBay's keyword grouping.
import { appraise } from "../appraiser.js";
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 600) : ""}`)); };
const jr = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const said = text => jr({ choices: [{ message: { content: typeof text === "string" ? text : JSON.stringify(text) } }] });
const row = (title, p, n) => ({ title, url: "https://www.ebay.com/itm/" + n, soldPrice: String(p), soldCurrency: "USD", shippingPrice: "0", endedAt: "2026-11-01", condition: "Pre-Owned" });
let mode = "thin";
const soldKw = [];
globalThis.fetch = async (u, init = {}) => {
  const url = new URL(String(u));
  if (url.hostname === "query2.finance.yahoo.com") return jr({}, 404);
  if (url.pathname.endsWith("/oauth2/token")) return jr({ access_token: "t", expires_in: 7200 });
  if (url.pathname.endsWith("/item_summary/search")) return jr({ itemSummaries: [] });
  if (url.hostname === "api.tavily.com") return jr({ results: [] });
  if (url.hostname === "api.sold-comps.com") {
    const kw = url.searchParams.get("keyword"); soldKw.push(kw);
    if (/cartridge only/.test(kw)) return jr({ items: [row("Metroid NES Cartridge Only Authentic Tested", 38, 301), row("Metroid (Nintendo NES, 1987) Cart Only", 42, 302), row("Metroid NES loose authentic", 45, 303)] });
    // the plain query: bundles, a CIB and a reproduction - one usable sale when mode is thin, three when rich
    const base = [row("Metroid NES CIB complete in box", 190, 101), row("Metroid NES Brand New sealed", 400, 102), row("Metroid NES Authentic Tested", 40, 103)];
    return jr({ items: mode === "rich" ? [...base, row("Metroid NES authentic cart", 41, 104), row("Metroid Nintendo NES authentic", 39, 105)] : base });
  }
  if (url.pathname.endsWith("/chat/completions")) {
    const body = JSON.parse(init.body); const sys = body.messages[0].content, user = body.messages[body.messages.length - 1].content;
    if (/pricing an item against live comparable listings/.test(sys)) {
      const kept = [...user.matchAll(/"title": "([^"]+)"[\s\S]*?"price": ([\d.]+)[\s\S]*?"url": "([^"]+)"/g)].map(m => ({ title: m[1], price: Number(m[2]), url: m[3], source: "ebay.com (sold)" })).slice(0, 4);
      return said({ comparables: kept, rejected: [], price_range: { low: 38, high: 45, suggested_retail: 41, floor: 35, currency: "USD", basis: "sales" } });
    }
    if (/setting a retail price/.test(sys)) return said({ low: 38, high: 45, suggested_retail: 41, floor: 35, currency: "USD", basis: "cold" });
    if (/writing for an independent antique dealer/.test(sys))
      return said({ identification: { name: "Metroid NES cartridge", category: "Video game", maker: "Nintendo", origin: "", period: "1987", style: "" }, confidence: 0.95, evidence: [], transcribed_text: [],
        price_range: { low: 30, high: 50, suggested_retail: 40, floor: 25, currency: "USD", basis: "memory" }, listing: { title: "Metroid NES", description: "", tags: [], condition_grade: "Good" }, questions_for_dealer: [], shipping: { item_weight_lb: 0.3, item_in: [5, 4, 1], fragile: false, basis: "" } });
    return jr({ error: "unrouted" }, 500);
  }
  return jr({ errors: [{ message: "unstubbed " + url }] }, 404);
};
const env = { NEBIUS_API_KEY: "k", EBAY_CLIENT_ID: "c", EBAY_CLIENT_SECRET: "s", SOLDCOMPS_API_KEY: "sc_test" };
const run = async (m, description) => { mode = m; soldKw.length = 0; return appraise(env, { photos: [], description, markings: "", currency: "USD" }); };
const W = r => (r.warnings || []).join(" | ");

let r = await run("thin", "Metroid original NES gray cartridge only, US, 1987");
ok("thin loose pool -> a second sold search asks for loose copies", soldKw.some(k => /\("cartridge only","cart only","disc only",loose\)$/.test(k)), soldKw);
ok("the loose sales are added and the dealer is told", /3 more sales of loose copies found with a second search/.test(W(r)), W(r));
ok("priced from the merged sales, including the second search's", r.sold_market && r.sold_market.count >= 2 && (r.sold_market.recent || []).some(x => /itm\/30[123]/.test(x.url)), r.sold_market);
r = await run("rich", "Metroid original NES gray cartridge only, US, 1987");
ok("enough loose sales first time -> no second search", !soldKw.some(k => /cartridge only/.test(k)) && !/second search/.test(W(r)), soldKw);
r = await run("thin", "Metroid NES, complete in box with manual");
ok("a complete copy never asks for loose ones", !soldKw.some(k => /cartridge only/.test(k)), soldKw);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

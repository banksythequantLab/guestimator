// Run:  node worker/tests/listing_copy_test.mjs
// The listing title and shop text, written after the price (2026-10-05): what the writer is told,
// what it returns, and that the estimate's own prompt no longer asks for prose.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeListingCopy, makerQueryName, makerMarket, repricePrompt } from "../appraiser.js";

let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };
const env = { NEBIUS_API_KEY: "k", NEBIUS_BASE_URL: "https://llm.test/v1/", TEXT_MODEL: "t", VISION_MODEL: "v" };
const result = { identification: { name: "Red Wing 3-gallon salt-glazed crock", maker: "Red Wing", period: "c. 1900", category: "Stoneware" },
  listing: { condition_grade: "Good" }, evidence: ["Oval Red Wing stamp under the glaze", "Hairline crack near the rim"],
  transcribed_text: ["RED WING", "3"], price_range: { low: 90, high: 140, suggested_retail: 120 } };

let sent = null;
globalThis.fetch = async (u, init) => { sent = { url: String(u), body: JSON.parse(init.body) };
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "Red Wing 3 Gallon Salt Glaze Stoneware Crock c1900",
    description: "A Red Wing three-gallon crock.\n\nOval stamp under the glaze. Hairline near the rim.", tags: ["red wing", "crock", "stoneware"] }) } }] }), { status: 200 }); };
const c = await writeListingCopy(env, result, { name: "crock" });
const prompt = sent && sent.body.messages.map(m => m.content).join("\n");
ok("returns title, text and tags", c && c.title.startsWith("Red Wing 3 Gallon") && /Oval stamp/.test(c.description) && c.tags.length === 3, c);
ok("told the identification, condition, evidence and marks", /Red Wing 3-gallon/.test(prompt) && /Condition: Good/.test(prompt) && /Hairline crack/.test(prompt) && /RED WING; 3/.test(prompt), prompt);
ok("never given the price, and told not to write one", !/\b120\b|\$90|\b140\b/.test(prompt.replace(/No prices\./, "")) && /No prices/.test(prompt));

globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "x", description: "" }) } }] }), { status: 200 });
ok("no text back -> null, so nothing empty is saved", (await writeListingCopy(env, result)) === null);
ok("no key -> null, no call", (await writeListingCopy({}, result)) === null);

// The estimate prompt itself no longer asks for the prose (that is the time saved).
const here = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(here, "..", "appraiser.js"), "utf8");
ok("identify schema asks only for the condition grade", APP.includes(' "listing": {"condition_grade": ""},') && !APP.includes('"listing": {"title": "", "description"'));
const WRK = readFileSync(join(here, "..", "worker.js"), "utf8");
ok("written after the price is saved, and before an eBay draft if still missing", /status='done'[\s\S]{0,600}ensureListingCopy\(env, db, appraisalId/.test(WRK) && /listing\?\.description\) await ensureListingCopy\(env, db, bundle\.appraisal\.id/.test(WRK));

// The web search runs on every estimate, alongside eBay, not only when eBay is thin (2026-10-06).
ok("web search always runs, in parallel with both eBay searches", /Promise\.all\(\[timed\("ebay_active"[\s\S]{0,200}timed\("web_search", searchComps\(env, q\)/.test(APP) && !/soldHits\.length >= 3 \? \[\] : await searchComps/.test(APP));

// ---------- the maker's own market (2026-10-06) ----------
ok("maker name cleaned for the search", makerQueryName("attributed to Stefan Kosik (signed lower right)") === "Stefan Kosik" && makerQueryName("Unknown") === null && makerQueryName("unsigned") === null && makerQueryName("") === null, makerQueryName("attributed to Stefan Kosik (signed lower right)"));
let tq = null;
globalThis.fetch = async (u, init) => { tq = JSON.parse(init.body); return new Response(JSON.stringify({ results: [
  { title: "Stefan Kosik, Portrait of a Lady, oil on canvas - sold $1,200", url: "https://www.liveauctioneers.com/item/1", content: "Stefan Kosik (Czech, b.1971) oil on canvas. Sold for $1,200." },
  { title: "Unrelated portrait painting $40", url: "https://www.liveauctioneers.com/item/2", content: "Anonymous portrait." }] }), { status: 200 }); };
const mw = await makerMarket({ TAVILY_API_KEY: "t" }, "Stefan Kosik", "Paintings");
ok("searches auction sites for the maker by name", tq && /"Stefan Kosik"/.test(tq.query) && /auction results/.test(tq.query) && tq.include_domains.includes("liveauctioneers.com"), tq);
ok("keeps only pages about the maker", mw.length === 1 && /Kosik/.test(mw[0].title), mw);
ok("no maker -> no search", (await makerMarket({ TAVILY_API_KEY: "t" }, "unknown")).length === 0);
const rp = repricePrompt({ ident: { name: "Portrait", maker: "Stefan Kosik" }, hits: [], makerWorks: mw });
ok("repricer told these are the maker's other works, not comparables", /OTHER WORKS BY THE SAME MAKER \(Stefan Kosik\)/.test(rp) && /never keep them as comparables/.test(rp) && rp.includes("liveauctioneers.com/item/1"));
ok("no maker works -> prompt unchanged", !/OTHER WORKS/.test(repricePrompt({ ident: { name: "x" }, hits: [] })));
ok("maker search runs alongside the others", /timed\("maker_search", makerMarket\(env, ident\.maker, ident\.category\)/.test(APP));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

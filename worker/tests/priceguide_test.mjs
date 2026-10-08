// Run:  node worker/tests/priceguide_test.mjs
// Public price-guide pages: built only from eBay-listed items, never show who sells, escape text,
// canonical URLs, sitemap and robots.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as P from "../priceguide.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

ok("slugify", P.slugify("Intel Optane™ 256GB — DCPMM (used)") === "intel-optane-256gb-dcpmm-used" && P.slugify("") === "item");

globalThis.fetch = async () => new Response("{}", { status: 404 });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, ASSETS: { fetch: async () => new Response("asset") }, PUBLIC_ORIGIN: "https://g.test", EMAIL: { send: async () => ({}) } };
const get = async path => { const r = await worker.fetch(new Request("https://g.test" + path, { redirect: "manual" }), env, { waitUntil() {} }); return { status: r.status, text: await r.text(), loc: r.headers.get("location"), type: r.headers.get("content-type") }; };
const now = new Date().toISOString();
const result = (extra = {}) => JSON.stringify({
  identification: { name: "Intel Optane 256GB", maker: "Intel", category: "Computer Memory", period: "c. 2018-2020" },
  price_range: { low: 190, high: 260 }, market: { count: 4, low: 190, high: 390, median: 242, as_of: now },
  comparables: [{ title: "Intel Optane 256GB <b>DCPMM</b>", price: 189.99, condition: "Used", seller: "secretseller42", url: "https://www.ebay.com/itm/1" }],
  live_listings: [{ title: "x", seller: "djsoltis", price: 60 }], ...extra });
function seed(n, { title, listingId, status = "published", res = result(), itemStatus = "live" }) {
  db.raw.prepare("INSERT INTO items (id,sale_id,name,price_cents,created_at,ai_title,listing_status) VALUES (?,?,?,0,?,?,?)").run("i" + n, "s1", "thing", now, title, itemStatus);
  db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)").run("a" + n, "i" + n, res, now);
  db.raw.prepare("INSERT INTO ebay_listings (id,item_id,user_id,sku,status,listing_id,listing_url,price_cents,created_at,updated_at,sold_count,sold_median_cents,sold_checked_at) VALUES (?,?,?,?,?,?,?,?,?,?,5,21500,?)")
    .run("l" + n, "i" + n, "u1", "GUESS-" + n, status, listingId, listingId ? `https://www.ebay.com/itm/${listingId}` : null, 19900, now, now, now);
}
seed(1, { title: "Intel Optane 256GB <script>x</script>", listingId: "117372168537" });
seed(2, { title: "Draft thing", listingId: null, status: "draft" });
seed(3, { title: "No price", listingId: "117000000003", res: JSON.stringify({ price_range: { low: 0, high: 0 }, market: {} }) });
seed(4, { title: "Sold lamp", listingId: "117000000004", itemStatus: "sold" });

const gs = await P.allGuides(db);
ok("only eBay-listed items with a price", gs.map(g => g.listing_id).sort().join() === "117000000004,117372168537", gs.map(g => g.listing_id));
const path = P.pagePath(gs.find(g => g.listing_id === "117372168537"));
ok("canonical path", path === "/price/intel-optane-256gb-script-x-script-117372168537", path);
let r = await get(path);
ok("page renders with range, sold median and asking prices", r.status === 200 && r.text.includes("$190 – $260") && r.text.includes("median $215 across 5 sales") && r.text.includes("across 4 comparable listings"));
ok("never shows sellers", !r.text.includes("secretseller42") && !r.text.includes("djsoltis"));
ok("text escaped (no injected script)", !r.text.includes("<script>x</script>") && r.text.includes("&lt;script&gt;") && !r.text.includes("<b>DCPMM</b>"));
ok("live listing -> Product offer in JSON-LD + listing link", r.text.includes('"@type":"Offer"') && r.text.includes('"price":"199.00"') && r.text.includes("https://www.ebay.com/itm/117372168537"));
ok("CTA to the app", r.text.includes('href="/?utm_source=price_guide"'));
const sold = await get(P.pagePath(gs.find(g => g.listing_id === "117000000004")));
ok("sold item: no offer, no 'for sale'", sold.status === 200 && !sold.text.includes('"@type":"Offer"') && !sold.text.includes("This one is for sale"));
r = await get("/price/wrong-slug-117372168537");
ok("wrong slug -> 301 to canonical", r.status === 301 && r.loc === "https://g.test" + path);
ok("unknown / unpriced -> 404 noindex", (await get("/price/x-117000000003")).status === 404 && (await get("/price/nothing-999999999")).text.includes("noindex"));
r = await get("/prices");
ok("index lists both", r.status === 200 && r.text.includes(path) && r.text.includes("Sold lamp"));
r = await get("/sitemap.xml");
ok("sitemap", r.type.startsWith("application/xml") && r.text.includes(`<loc>https://g.test${path}</loc>`) && r.text.includes("<loc>https://g.test/prices</loc>"));
r = await get("/robots.txt");
ok("robots: API and private pages out, sitemap in", r.text.includes("Disallow: /api/") && r.text.includes("Disallow: /owner") && r.text.includes("Sitemap: https://g.test/sitemap.xml"));

// ---------- eBay Partner Network + seller's hide switch ----------
r = await get(path);
ok("live listing link carries the EPN campaign", /https:\/\/www\.ebay\.com\/itm\/117372168537\?[^"]*campid=5339215150[^"]*customid=gs-guide/.test(r.text.replace(/&amp;/g, "&")) && r.text.includes('rel="sponsored nofollow noopener"'));
ok("comparable links tagged too, query stripped first", r.text.replace(/&amp;/g, "&").includes("https://www.ebay.com/itm/1?mkcid=1"));
ok("commission disclosed", r.text.includes("may be paid a commission"));
let st = await P.guideStatus(db, "i1", "https://g.test");
ok("status: on the guide with its URL", st.eligible && !st.hidden && st.url === "https://g.test" + path, st);
db.raw.prepare("UPDATE items SET guide_hidden=1 WHERE id='i1'").run();
st = await P.guideStatus(db, "i1", "https://g.test");
ok("hidden: off the page, the index and the sitemap", st.hidden && !st.url && (await get(path)).status === 404 && !(await get("/prices")).text.includes(path) && !(await get("/sitemap.xml")).text.includes(path), st);
ok("draft item isn't eligible", !(await P.guideStatus(db, "i2", "https://g.test")).eligible);
db.raw.prepare("UPDATE items SET guide_hidden=NULL WHERE id='i1'").run();
ok("shown again", (await get(path)).status === 200);

// SEO extras: aggregate offer when nothing is live, breadcrumbs, links to other guides
{
  const PG = await import("../priceguide.js");
  const g = { listing_id: "1", title: "Tin toy", range: { low: 10, high: 30 }, market: { count: 4, low: 12, high: 40, median: 20 }, sold: null,
    about: {}, comps: [], estimated_at: "2026-10-01", updated_at: "2026-10-01", live: null, sold_on_ebay: false };
  const o = { ...g, listing_id: "2", title: "Brass lamp" };
  const h = PG.guidePage(g, "https://g.test", [o]);
  ok("no live listing -> AggregateOffer from comparable listings", h.includes('"@type":"AggregateOffer"') && h.includes('"lowPrice":"12.00"') && h.includes('"offerCount":4'));
  ok("breadcrumbs in JSON-LD", h.includes('"@type":"BreadcrumbList"') && h.includes('"item":"https://g.test/prices"'));
  ok("links to other price-guide pages", h.includes("More from the price guide") && h.includes('href="/price/brass-lamp-2"'));
  ok("no market data -> no offers at all", !PG.guidePage({ ...g, market: null }, "https://g.test").includes('"offers"'));
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

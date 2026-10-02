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

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

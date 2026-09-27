// Run:  node worker/tests/ebay_test.mjs
// The rules that decide what goes onto someone's eBay listing. None of these call eBay: they are
// the part we own, and each one exists because eBay rejects the listing - at publish, after the
// credit is taken - when it is wrong.
import * as E from "../ebay.js";

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.log(`FAIL ${n}`)); };
const eq = (n, a, b) => ok(`${n} (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

// ---- titles: 80 characters, cut on a word ----
eq("short title untouched", E.ebayTitle("Red Wing 3-Gallon Crock"), "Red Wing 3-Gallon Crock");
eq("whitespace collapsed", E.ebayTitle("  Red   Wing\n Crock "), "Red Wing Crock");
const long = "Red Wing 3-Gallon Stoneware Crock, Union Stoneware Co. Oval Stamp, Cobalt Capacity Mark, c. 1920";
const t = E.ebayTitle(long);
ok("long title fits eBay's 80", t.length <= 80);
ok("long title is cut on a word", long.startsWith(t) && /\s/.test(long[t.length] || " "));
ok("no dangling comma", !/[,\s]$/.test(t));
ok("80 exactly is kept whole", E.ebayTitle("x".repeat(80)).length === 80);
ok("one unbroken 90-char word still fits", E.ebayTitle("y".repeat(90)).length === 80);
eq("empty stays empty", E.ebayTitle(""), "");

// ---- condition: the category's list decides ----
const ANTIQUES = ["1000", "3000"];                 // what most antiques categories allow
eq("Very good in antiques -> Used", E.conditionFor("Very good", ANTIQUES), "USED_EXCELLENT");
eq("Excellent in antiques -> Used", E.conditionFor("Excellent", ANTIQUES), "USED_EXCELLENT");
eq("As-is in antiques -> Used, never New", E.conditionFor("As-is", ANTIQUES), "USED_EXCELLENT");
const BOOKS = ["1000", "2750", "4000", "5000", "6000"];
eq("Very good book -> USED_VERY_GOOD", E.conditionFor("Very good", BOOKS), "USED_VERY_GOOD");
eq("Good book -> USED_GOOD", E.conditionFor("Good", BOOKS), "USED_GOOD");
eq("Poor book -> USED_ACCEPTABLE", E.conditionFor("Poor", BOOKS), "USED_ACCEPTABLE");
const APPAREL = ["1000", "1500", "2990", "3000", "3010"];
eq("Excellent apparel -> PRE_OWNED_EXCELLENT", E.conditionFor("Excellent", APPAREL), "PRE_OWNED_EXCELLENT");
eq("Fair apparel -> PRE_OWNED_FAIR", E.conditionFor("Fair", APPAREL), "PRE_OWNED_FAIR");
eq("grade case/spacing ignored", E.conditionFor("  VERY GOOD ", BOOKS), "USED_VERY_GOOD");
eq("unknown grade falls to Used", E.conditionFor("Mint-ish", ANTIQUES), "USED_EXCELLENT");
eq("no category info -> Used", E.conditionFor("Good", null), "USED_EXCELLENT");
eq("As-is with no info is NOT for-parts", E.conditionFor("As-is", []), "USED_EXCELLENT");
eq("new-only category -> null, not a rejected guess", E.conditionFor("Good", ["1000"]), null);
eq("never picks for-parts as a fallback", E.conditionFor("Good", ["1000", "7000"]), null);
eq("falls back to another used condition", E.conditionFor("Good", ["1000", "2750"]), "LIKE_NEW");

// ---- price: never $0 ----
eq("suggested retail first", E.startingPrice({ price_range: { low: 90, high: 160, suggested_retail: 135 }, market: { median: 120 } }), 135);
// The exact shape from the phone bug: range all zero, four good comps.
eq("zero range falls to market median", E.startingPrice({ price_range: { low: 0, high: 0, suggested_retail: 0 }, market: { count: 4, median: 242 } }), 242);
eq("midpoint when no retail and no market", E.startingPrice({ price_range: { low: 90, high: 160 } }), 125);
eq("nothing usable -> null", E.startingPrice({ price_range: { low: 0, high: 0, suggested_retail: 0 } }), null);
eq("no result -> null", E.startingPrice(null), null);
eq("cents kept", E.startingPrice({ price_range: { suggested_retail: 19.999 } }), 20);

// ---- SKU ----
const sku = E.skuFor("3f2a9c1e-7b44-4c2d-9e1a-0b6c5d4e3f21");
ok("sku is alphanumeric+dash only", /^[A-Za-z0-9-]+$/.test(sku));
ok("sku within 50", sku.length <= 50);
ok("sku is stable", sku === E.skuFor("3f2a9c1e-7b44-4c2d-9e1a-0b6c5d4e3f21"));

// ---- images ----
const photos = [
  { r2_key: "i/a.jpg", kind: "back", content_type: "image/jpeg" },
  { r2_key: "i/b.heic", kind: "marks", content_type: "image/heic" },
  { r2_key: "i/c.jpg", kind: "front", content_type: "image/jpeg" },
  { r2_key: "i/d.png", kind: "detail", content_type: "image/png" },
];
const urls = E.imageUrls(photos, "https://g.example.dev/");
eq("front first, HEIC dropped, absolute https", urls,
   ["https://g.example.dev/p/i/c.jpg", "https://g.example.dev/p/i/a.jpg", "https://g.example.dev/p/i/d.png"]);
ok("capped at eBay's 24", E.imageUrls(Array.from({ length: 30 }, (_, i) => ({ r2_key: `k${i}.jpg`, content_type: "image/jpeg" })), "https://x").length === 24);
ok("missing content type treated as jpeg", E.imageUrls([{ r2_key: "k.jpg" }], "https://x").length === 1);

// ---- description ----
eq("paragraphs and escaping", E.descriptionHtml("A <b> crock & lid.\n\nSound rim.\nNo chips."),
   "<p>A &lt;b&gt; crock &amp; lid.</p>\n<p>Sound rim.<br>No chips.</p>");

// ---- aspects ----
const RAW = [
  { localizedAspectName: "Brand", aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT", itemToAspectCardinality: "SINGLE" }, aspectValues: [{ localizedValue: "Red Wing" }] },
  { localizedAspectName: "Type", aspectConstraint: { aspectRequired: true, aspectMode: "SELECTION_ONLY", itemToAspectCardinality: "SINGLE" }, aspectValues: [{ localizedValue: "Crock" }, { localizedValue: "Jug" }] },
  { localizedAspectName: "Color", aspectConstraint: { aspectUsage: "RECOMMENDED", aspectMode: "FREE_TEXT", itemToAspectCardinality: "MULTI" }, aspectValues: [] },
  { localizedAspectName: "Obscure", aspectConstraint: { aspectUsage: "OPTIONAL" }, aspectValues: [] },
];
const spec = E.aspectSpec(RAW);
eq("spec keeps required + recommended only", spec.map(s => s.name), ["Brand", "Type", "Color"]);
ok("selection-only flagged", spec[1].selection_only && !spec[0].selection_only);
ok("recommended cap honoured", E.aspectSpec(Array.from({ length: 20 }, (_, i) => ({ localizedAspectName: `R${i}`, aspectConstraint: { aspectUsage: "RECOMMENDED" } })), 8).length === 8);

const cleaned = E.cleanAspects({ brand: "Red Wing", Type: "crock", Color: ["Blue", "Gray", ""], Nope: "x" }, spec);
eq("names matched case-insensitively, eBay spelling restored, blanks and unknowns dropped", cleaned,
   { Brand: ["Red Wing"], Type: ["Crock"], Color: ["Blue", "Gray"] });
eq("selection-only value not in the list is dropped", E.cleanAspects({ Type: "Bowl" }, spec), {});
eq("single-cardinality keeps one value", E.cleanAspects({ Brand: ["A", "B"] }, spec), { Brand: ["A"] });
ok("free text capped at 65", E.cleanAspects({ Brand: "z".repeat(90) }, spec).Brand[0].length === 65);
eq("missing required named", E.missingRequired({ Brand: ["X"] }, spec), ["Type"]);
eq("nothing missing", E.missingRequired(cleaned, spec), []);

eq("Brand from the maker", E.seedAspects(spec, { maker: "Red Wing Union Stoneware Co." }), { Brand: ["Red Wing Union Stoneware Co."] });
eq("Brand Unbranded when maker unknown", E.seedAspects(spec, { maker: "Unknown" }), { Brand: ["Unbranded"] });
eq("Brand Unbranded when no maker", E.seedAspects(spec, {}), { Brand: ["Unbranded"] });
eq("no Brand aspect, nothing seeded", E.seedAspects([spec[1]], { maker: "X" }), {});

// ---- errors in eBay's words ----
eq("longMessage with id", E.ebayErrorText({ errors: [{ errorId: 25002, message: "short", longMessage: "An offer already exists" }] }, 400),
   "An offer already exists (eBay 25002)");
eq("empty body", E.ebayErrorText(null, 503), "eBay returned 503");

// ---- shipping policy body ----
const fp = E.fulfillmentPolicyBody("12.5", 2);
ok("flat cost formatted", fp.shippingOptions[0].shippingServices[0].shippingCost.value === "12.50");
ok("name carries the price, so re-use finds it", fp.name === "Guestimator flat $12.50 shipping");
ok("free shipping when 0", E.fulfillmentPolicyBody(0, 3).shippingOptions[0].shippingServices[0].freeShipping === true);
ok("handling clamped", E.fulfillmentPolicyBody(5, 99).handlingTime.value === 10 && E.fulfillmentPolicyBody(5, 0).handlingTime.value === 3);

// ---- consent URL ----
const cu = new URL(E.consentUrl({ EBAY_CLIENT_ID: "cid", EBAY_RUNAME: "Derek-Guest-PRD-abc" }, "st8"));
ok("consent on production auth host", cu.origin === "https://auth.ebay.com");
ok("RuName goes in redirect_uri", cu.searchParams.get("redirect_uri") === "Derek-Guest-PRD-abc");
ok("scopes include sell.inventory and sell.account", /sell\.inventory/.test(cu.searchParams.get("scope")) && /sell\.account/.test(cu.searchParams.get("scope")));
ok("state carried", cu.searchParams.get("state") === "st8" && cu.searchParams.get("response_type") === "code");

// ---- token sealing round-trips and is not plaintext ----
const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64");
const sealed = await E.seal({ EBAY_TOKEN_KEY: key }, "v^1.1#refresh-token");
ok("sealed is not the token", !sealed.includes("refresh-token"));
ok("round trip", (await E.unseal({ EBAY_TOKEN_KEY: key }, sealed)) === "v^1.1#refresh-token");
ok("fresh IV each time", sealed !== await E.seal({ EBAY_TOKEN_KEY: key }, "v^1.1#refresh-token"));
let threw = false; try { await E.unseal({ EBAY_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64") }, sealed); } catch { threw = true; }
ok("wrong key cannot open it", threw);
threw = false; try { await E.seal({ EBAY_TOKEN_KEY: "c2hvcnQ=" }, "x"); } catch { threw = true; }
ok("short key refused", threw);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

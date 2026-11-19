// Run: node worker/tests/es_test.mjs
// Spanish price pages (2026-11-19): /es/price/..., hreflang both ways, Spanish text, English comparables,
// the translate sweep, and the sitemap.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as P from "../priceguide.js";
import * as E from "../priceguide_es.js";
const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 500) : ""}`)); };

// model stub for the translate sweep; everything else 404
let asked = [];
globalThis.fetch = async (u, init = {}) => {
  if (String(u).endsWith("chat/completions")) {
    const body = JSON.parse(init.body); asked.push(body);
    const items = JSON.parse(body.messages[1].content).items.map(it => ({ id: it.id, title_es: it.title.replace("N64 cartridge", "cartucho de N64").replace("GameCube game", "juego de GameCube"), category_es: "Videojuego" }));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
};
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, ASSETS: { fetch: async () => new Response("asset") }, PUBLIC_ORIGIN: "https://g.test", EMAIL: { send: async () => ({}) }, NEBIUS_API_KEY: "k", PRICE_REFRESH_OWNER: "dj@soltis.info" };
const get = async path => { const r = await worker.fetch(new Request("https://g.test" + path, { redirect: "manual" }), env, { waitUntil() {} }); return { status: r.status, text: await r.text(), loc: r.headers.get("location") }; };
const now = new Date().toISOString();
const res = (name, low, high) => JSON.stringify({ identification: { name, maker: "Nintendo", category: "Video game", period: "1998" }, price_range: { low, high }, confidence: 0.9,
  sold_market: { count: 4, low, median: Math.round((low + high) / 2), high, as_of: now },
  comparables: [{ title: "Zelda Ocarina of Time N64 Authentic Tested", price: low, condition: "Pre-Owned", source: "ebay.com (sold)", url: "https://www.ebay.com/itm/1" }, { title: "Legend of Zelda OoT N64 cart only", price: high, condition: "Pre-Owned", source: "ebay.com (sold)", url: "https://www.ebay.com/itm/2" }] });
// opt-in pages (no eBay listing), owned by the owner
db.raw.prepare("INSERT INTO users (id,email,pw_hash,pw_salt,created_at) VALUES ('u1','dj@soltis.info','h','s',?)").run(now);
db.raw.prepare("INSERT INTO sales (id,name,created_at,user_id) VALUES ('s1','x',?,'u1')").run(now);
const seed = (n, title, low, high) => {
  db.raw.prepare("INSERT INTO items (id,sale_id,name,price_cents,created_at,guide_title,guide_public,listing_status) VALUES (?,?,?,0,?,?,1,'draft')").run(n, "s1", title, now, title);
  db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)").run("ap-" + n.slice(0,8), n, res(title, low, high), now);
};
seed("aaaa1111-bbbb-2222-cccc-000000000001", "Zelda Ocarina of Time N64 cartridge", 51, 69);
seed("cccc3333-dddd-4444-eeee-000000000002", "Zelda Majora's Mask N64 cartridge", 60, 80);
seed("eeee5555-ffff-6666-aaaa-000000000003", "Luigi's Mansion GameCube game", 50, 70);

let gs = await P.allGuides(db);
ok("three English pages, none Spanish yet", gs.length === 3 && gs.every(g => !E.hasEs(g)), gs.map(g => g.title));
const oot = gs.find(g => /Ocarina/.test(g.title));
let r = await get(`/es/price/anything-${oot.listing_id}`);
ok("no Spanish title -> sent to the English page", r.status === 302 && r.loc === "https://g.test" + P.pagePath(oot), r);
ok("English page carries no hreflang yet", !(await get(P.pagePath(oot))).text.includes('hreflang="es"'));
ok("sitemap has no /es/ yet", !P.sitemap(gs, "https://g.test").includes("/es/"));

// translate two of the three
const sw = await E.translateSweep(env, db, ["aaaa1111-bbbb-2222-cccc-000000000001", "cccc3333-dddd-4444-eeee-000000000002", "item-nope"]);
ok("sweep: two written, unknown skipped, one model call for the batch", sw.written.length === 2 && sw.skipped.includes("item-nope") && asked.length === 1, sw);
ok("sweep: asked with thinking off", asked[0].chat_template_kwargs && asked[0].chat_template_kwargs.enable_thinking === false, asked[0]);
gs = await P.allGuides(db);
const es = gs.find(g => /Ocarina/.test(g.title));
ok("Spanish title stored and read back", E.hasEs(es) && es.es.title === "Zelda Ocarina of Time cartucho de N64" && es.es.category === "Videojuego", es.es);
const ep = E.esPath(es);
ok("Spanish path from the Spanish title", ep === `/es/price/zelda-ocarina-of-time-cartucho-de-n64-${es.listing_id}`, ep);

r = await get(ep);
ok("Spanish page serves", r.status === 200 && r.text.includes('<html lang="es"'), r.status);
ok("Spanish page: title, h1, sold line, FAQ in Spanish", r.text.includes("cuánto vale</h1>") && r.text.includes("Vendidos recientemente en eBay") && r.text.includes("¿Cuánto vale un Zelda Ocarina of Time cartucho de N64?") && r.text.includes("precio $51–$69</title>"));
ok("Spanish page: comparables keep their English eBay titles", r.text.includes("Zelda Ocarina of Time N64 Authentic Tested") && r.text.includes("(vendido)"));
ok("Spanish page: hreflang to English, Spanish and x-default", r.text.includes(`<link rel="alternate" hreflang="en" href="https://g.test${P.pagePath(es)}">`) && r.text.includes(`<link rel="alternate" hreflang="es" href="https://g.test${ep}">`) && r.text.includes('hreflang="x-default"'));
ok("Spanish page: canonical is itself, Spanish footer, Spanish header", r.text.includes(`<link rel="canonical" href="https://g.test${ep}">`) && r.text.includes("no tasaciones certificadas") && r.text.includes("Guía de precios Guestimator"));
ok("Spanish page: related links use the Spanish page when there is one, English otherwise", r.text.includes("/es/price/zelda-majora-s-mask-cartucho-de-n64-") && r.text.includes(`href="${P.pagePath(gs.find(g => /Luigi/.test(g.title)))}" hreflang="en"`), r.text.match(/Precios relacionados[\s\S]*$/)?.[0]?.slice(0, 600));
ok("Spanish page: no English footer or English hub words", !r.text.includes("not certified appraisals") && !r.text.includes("what it's worth"));
r = await get(`/es/price/wrong-slug-${es.listing_id}`);
ok("wrong Spanish slug -> 301 to the right one", r.status === 301 && r.loc === "https://g.test" + ep, r);
const en = await get(P.pagePath(es));
ok("English page now links the Spanish one", en.text.includes(`<link rel="alternate" hreflang="es" href="https://g.test${ep}">`) && en.text.includes('<html lang="en"'));
const sm = P.sitemap(gs, "https://g.test");
ok("sitemap: Spanish index and the two Spanish pages, not the untranslated one", sm.includes("https://g.test/es/prices<") && sm.includes(`https://g.test${ep}<`) && (sm.match(/\/es\/price\//g) || []).length === 2);
r = await get("/es/prices");
ok("Spanish index lists the Spanish pages under a Spanish hub name", r.status === 200 && r.text.includes("Videojuegos y consolas") && r.text.includes("2 artículos en español") && r.text.includes(ep));
r = await get("/es/price/nothing-999999999999");
ok("unknown id -> Spanish index", r.status === 302 && r.loc === "https://g.test/es/prices", r);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

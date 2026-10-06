// Run:  node worker/tests/share_test.mjs
// "Share your price" (2026-10-06): the link, the public page, what it never shows, and cleanup.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };
globalThis.fetch = async () => new Response("{}", { status: 404 });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const pending = [];
const env = { DB: db, ASSETS: { fetch: async () => new Response("asset") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", EMAIL: { send: async () => ({ messageId: "m" }) } };
const jar = {}; let who = "sam";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie: jar[who] || "" },
    body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil(p) { pending.push(p); } });
  while (pending.length) await pending.shift();
  const sc = r.headers.get("set-cookie"); if (sc) jar[who] = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
};
await call("POST", "/api/auth/register", { email: "sam@example.com", password: "password123" });
const item = (await call("POST", "/api/items", { name: "Portrait", description: "oil portrait, signed Kosik" })).json.id;
let seq = 0;
const addAp = (result) => db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)")
  .run(crypto.randomUUID(), item, JSON.stringify(result), new Date(Date.now() + (seq++) * 60000).toISOString());
db.raw.prepare("INSERT INTO photos (id,item_id,r2_key,kind,sort,created_at,content_type,bytes) VALUES (?,?,?,?,0,?,'image/jpeg',1000)").run("ph1", item, "u/abc/front.jpg", "front", new Date().toISOString());

addAp({ identification: { name: "Portrait of a woman", maker: "Stefan Kosik" }, needs_clarification: { question: "Signed?" }, price_range: { low: 5, high: 30 } });
ok("no share while it's asking a question", (await call("POST", `/api/items/${item}/share`)).status === 409);

addAp({ identification: { name: "Portrait of a Woman in Pink", maker: "Stefan Kosik", period: "2000s" }, listing: { title: "Stefan Kosik Portrait of a Woman in Pink, Oil" },
  price_range: { low: 80, high: 250, suggested_retail: 175 }, comparables: [{ title: "a", price: 120 }, { title: "b", price: 210 }], sold_market: { count: 2 } });
let r = await call("POST", `/api/items/${item}/share`);
const url = r.json && r.json.url;
ok("share gives a public link", r.status === 200 && /^https:\/\/g\.test\/e\/[a-z2-9]{10}$/.test(url), r.json);
ok("tapping again returns the same link", (await call("POST", `/api/items/${item}/share`)).json.url === url);

who = "eve"; await call("POST", "/api/auth/register", { email: "eve@example.com", password: "password123" });
ok("someone else can't share your item", (await call("POST", `/api/items/${item}/share`)).status === 404);

who = "nobody";
const page = await call("GET", url.replace("https://g.test", ""));
const code = db.raw.prepare("SELECT code FROM ref_codes WHERE user_id=(SELECT id FROM users WHERE email='sam@example.com')").get()?.code;
ok("public page: title, range, suggested, photo, evidence", page.status === 200 && page.text.includes("Stefan Kosik Portrait of a Woman in Pink, Oil") && page.text.includes("$80–$250")
  && page.text.includes("$175") && page.text.includes("https://g.test/p/u/abc/front.jpg") && /recent eBay sales and 2 comparable listings/.test(page.text), page.text.slice(0, 400));
ok("link-preview tags for texts and social posts", /og:image" content="https:\/\/g\.test\/p\/u\/abc\/front\.jpg"/.test(page.text) && /og:title" content="[^"]*\$80–\$250/.test(page.text) && /summary_large_image/.test(page.text));
ok("'price mine free' goes through the sharer's invite link", code && page.text.includes(`/?ref=${code}&amp;utm_source=share`), code);
ok("never shows the seller, their email or their notes, and isn't indexed", !page.text.includes("sam@example.com") && !page.text.includes("signed Kosik") && /noindex/.test(page.text) && page.headers.get("x-robots-tag") === "noindex");
ok("views counted", db.raw.prepare("SELECT views FROM estimate_shares").get().views === 1);
ok("unknown link -> 404", (await call("GET", "/e/nosuchtoken1")).status === 404);

who = "sam";
await call("DELETE", `/api/items/${item}`);
who = "nobody";
ok("deleting the item takes the page down", (await call("GET", url.replace("https://g.test", ""))).status === 404 && db.raw.prepare("SELECT COUNT(*) n FROM estimate_shares").get().n === 0);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

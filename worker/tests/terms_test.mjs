// Run:  node worker/tests/terms_test.mjs
// Market terms (2026-10-07): draft visible only to the owner until MARKET_TERMS_LIVE=on; once live,
// a seller agrees once, the first time they list (one item or in bulk), and it's recorded.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };
globalThis.fetch = async () => new Response("{}", { status: 404 });
const { default: worker } = await import("../worker.js");
const T = await import("../terms.js");
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, ASSETS: { fetch: async () => new Response("asset") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", ADMIN_EMAIL: "boss@example.com", EMAIL: { send: async () => ({ messageId: "m" }) } };
const jar = { sam: "", boss: "", anon: "" }; let who = "sam";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie: jar[who] },
    body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc && who !== "anon") jar[who] = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
await call("POST", "/api/auth/register", { email: "sam@example.com", password: "password123" });
who = "boss"; await call("POST", "/api/auth/register", { email: "boss@example.com", password: "password123" }); who = "sam";
const mk = async name => { const { json } = await call("POST", "/api/items", { name, description: name });
  db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)").run(crypto.randomUUID(), json.id,
    JSON.stringify({ identification: { name }, price_range: { low: 10, high: 40, suggested_retail: 25 } }), new Date().toISOString()); return json.id; };
const a = await mk("Lamp"), b = await mk("Vase"), c = await mk("Clock");

ok("no open decisions left in the text", T.termsReady() === true);
env.MARKET_TERMS_LIVE = "";
who = "anon"; ok("draft hidden from the public", (await call("GET", "/market-terms")).status === 404);
who = "sam"; ok("draft hidden from sellers", (await call("GET", "/market-terms")).status === 404);
who = "boss"; let r = await call("GET", "/market-terms");
ok("owner sees the draft, marked", r.status === 200 && r.text.includes("DRAFT, not in effect") && r.text.includes("Items you can&#39;t list"));
who = "sam";
ok("not live: listing needs no agreement", (await call("POST", `/api/market/items/${a}`, { price: "25", ship: "5" })).status === 200);
who = "anon"; ok("not live: Market has no terms link", !(await call("GET", "/market")).text.includes("/market-terms"));

env.MARKET_TERMS_LIVE = "on";
who = "anon"; r = await call("GET", "/market-terms");
ok("live: public, no draft banner", r.status === 200 && !r.text.includes("DRAFT") && r.text.includes("Version " + T.TERMS_VERSION));
ok("live: Market links the terms", (await call("GET", "/market")).text.includes('href="/market-terms"'));
who = "sam";
r = await call("POST", `/api/market/items/${b}`, { price: "25", ship: "5" });
ok("live: first listing asks for agreement", r.status === 428 && r.json.need_terms === true && r.json.terms_url === "https://g.test/market-terms", r.json);
ok("nothing listed without agreement", !db.raw.prepare("SELECT 1 FROM garage_sale_items WHERE item_id=?").get(b));
r = await call("POST", `/api/market/items/${b}`, { price: "25", ship: "5", agree_terms: true });
const u = db.raw.prepare("SELECT market_terms_at, market_terms_version FROM users WHERE email='sam@example.com'").get();
ok("agreeing lists it and records when and which version", r.status === 200 && !!u.market_terms_at && u.market_terms_version === T.TERMS_VERSION, u);
ok("asked only once", (await call("POST", `/api/market/items/${c}`, { price: "25", ship: "5" })).status === 200);
// a new version of the terms: asked again (2026-10-08)
db.raw.prepare("UPDATE users SET market_terms_version='2026-10-07' WHERE email='sam@example.com'").run();
const e2 = await mk("Bowl");
ok("new terms version: asked again", (await call("POST", `/api/market/items/${e2}`, { price: "25", ship: "5" })).status === 428);
r = await call("POST", `/api/market/items/${e2}`, { price: "25", ship: "5", agree_terms: true });
ok("agreeing records the new version", r.status === 200 && db.raw.prepare("SELECT market_terms_version v FROM users WHERE email='sam@example.com'").get().v === T.TERMS_VERSION);
ok("terms text: New Jersey law, NJ UCC for sales, cap at twice what was paid", /laws of the State of New Jersey/.test(JSON.stringify(T.TERMS)) && !/New York/.test(JSON.stringify(T.TERMS))
  && /Uniform Commercial Code as adopted in New Jersey/.test(JSON.stringify(T.TERMS)) && /twice what you paid Guestimator/.test(JSON.stringify(T.TERMS)));
ok("terms text: says how buyers and sellers agree; no gross-negligence exclusion", /Buyers agree by ticking the box/.test(JSON.stringify(T.TERMS)) && /gross negligence, willful misconduct or fraud/.test(JSON.stringify(T.TERMS)));

// bulk, for a seller who hasn't agreed
who = "boss";
const d = await mk("Teapot");
r = await call("POST", "/api/market/bulk", { items: [{ id: d, price: "30", ship: "6" }] });
ok("bulk asks too", r.status === 428 && r.json.need_terms === true, r.json);
r = await call("POST", "/api/market/bulk", { items: [{ id: d, price: "30", ship: "6" }], agree_terms: true });
ok("bulk with agreement lists", r.status === 200 && r.json.listed === 1, r.json);

console.log(`terms_test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

// Run:  node worker/tests/ratings_test.mjs
// New accounts start with free estimates; rating an estimate earns another (capped monthly).
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 400) : ""}`)); };
globalThis.fetch = async () => new Response("{}", { status: 404 });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, RATING_CREDITS_PER_MONTH: "2", PUBLIC_ORIGIN: "https://g.test", ASSETS: { fetch: async () => new Response("a") },
  PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} } };
let cookie = "";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return { status: r.status, json: await r.json().catch(() => null) };
};
let r = await call("GET", "/api/auth/config");
ok("config advertises 5 free credits and the rating cap", r.json.signup_credits === 5 && r.json.rating_credits === 2, r.json);
await call("POST", "/api/auth/register", { email: "r@example.com", password: "password123" });
const me = db.raw.prepare("SELECT id, credits FROM users WHERE email='r@example.com'").get();
ok("new account: 5 credits", me.credits === 5);
const credits = () => db.raw.prepare("SELECT credits FROM users WHERE id=?").get(me.id).credits;
const mkItem = async () => (await call("POST", "/api/items", { name: "Thing" })).json.id;
const doneEst = (item, funded) => db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at,funded_by) VALUES (?,?,'done','{}',?,?)").run(crypto.randomUUID(), item, new Date().toISOString(), funded);

const a = await mkItem(); doneEst(a, "credit");
r = await call("POST", `/api/items/${a}/rating`, { stars: 7 });
ok("stars must be 1-5", r.status === 400);
r = await call("POST", `/api/items/${a}/rating`, { stars: 4, note: "sold for $30" });
ok("rating a paid estimate earns 1 credit", r.status === 200 && r.json.credited === 1 && credits() === 6, r.json);
r = await call("POST", `/api/items/${a}/rating`, { stars: 2 });
ok("re-rating updates, no second credit", r.json.already && credits() === 6 && db.raw.prepare("SELECT stars FROM estimate_ratings").get().stars === 2);
r = await call("GET", `/api/items/${a}`);
ok("item shows the rating", r.json.appraisal.rating.stars === 2 && r.json.appraisal.rating.credited === 1);

const f = await mkItem(); doneEst(f, null);
r = await call("POST", `/api/items/${f}/rating`, { stars: 5 });
ok("rating a free follow-up earns nothing", r.json.credited === 0 && credits() === 6);

const b = await mkItem(); doneEst(b, "credit");
r = await call("POST", `/api/items/${b}/rating`, { stars: 5 });
ok("second paid rating this month earns", r.json.credited === 1 && credits() === 7);
const c = await mkItem(); doneEst(c, "credit");
r = await call("POST", `/api/items/${c}/rating`, { stars: 5 });
ok("monthly cap (2) reached: no more credit", r.json.credited === 0 && credits() === 7 && r.json.left_this_month === 0, r.json);
ok("ledger has the 5 signup + 2 rating credits", db.raw.prepare("SELECT SUM(credits_delta) n FROM billing_events WHERE user_id=?").get(me.id).n === 7);

const keep = cookie; cookie = "";
await call("POST", "/api/auth/register", { email: "x@example.com", password: "password123" });
ok("can't rate someone else's item", (await call("POST", `/api/items/${a}/rating`, { stars: 1 })).status === 404);
cookie = keep;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

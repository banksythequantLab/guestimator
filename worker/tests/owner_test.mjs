// Run:  node worker/tests/owner_test.mjs
// Owner dashboard: only the owner sees it, numbers come from the tables, text is escaped, and
// cron failures are recorded and pruned.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as O from "../owner.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

globalThis.fetch = async () => new Response("{}", { status: 404 });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, ASSETS: { fetch: async () => new Response("asset") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", LABEL_USERS: "boss@example.com", SHIPPO_API_TOKEN: "t", EMAIL: { send: async () => ({}) } };
const jar = {}; let who = "boss";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie: jar[who] || "" },
    body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc) jar[who] = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
for (const w of ["boss", "pat"]) { who = w; await call("POST", "/api/auth/register", { email: `${w}@example.com`, password: "password123" }); }

ok("isOwner: first LABEL_USERS, case-insensitive; ADMIN_EMAIL wins", O.isOwner(env, "Boss@Example.com") && !O.isOwner(env, "pat@example.com") &&
   O.isOwner({ ADMIN_EMAIL: "pat@example.com", LABEL_USERS: "boss@example.com" }, "pat@example.com") && !O.isOwner({}, "x@y.z"));
who = "pat";
ok("non-owner: /owner is a 404, no owner flag", (await call("GET", "/owner")).status === 404 && !(await call("GET", "/api/auth/me")).json.owner);
who = "nobody";
ok("signed out: 404", (await call("GET", "/owner")).status === 404);
who = "boss";
ok("owner flag on /me", (await call("GET", "/api/auth/me")).json.owner === true);

// seed: pat makes an estimate (one failed), a stuck label payment, a cron failure
who = "pat";
const item = (await call("POST", "/api/items", { name: "Lamp", description: "brass" })).json.id;
const pat = db.raw.prepare("SELECT id FROM users WHERE email='pat@example.com'").get().id, now = new Date().toISOString();
db.raw.prepare("INSERT INTO appraisals (id,item_id,status,error,created_at) VALUES (?,?,'error','Token Factory <timeout>',?)").run(crypto.randomUUID(), item, now);
db.raw.prepare("INSERT INTO appraisals (id,item_id,status,created_at) VALUES (?,?,'done',?)").run(crypto.randomUUID(), item, now);
db.raw.prepare("INSERT INTO label_payments (id,user_id,kind,order_id,rate_id,label_cents,fee_cents,processing_cents,total_cents,status,error,created_at,updated_at) VALUES ('lp1',?,'garage','g1','r',745,0,54,799,'stuck','interrupted',?,?)").run(pat, now, now);
await O.opsFail(db, "ebay order sync failed", new Error("eBay 500 <html>"));
await O.opsFail(db, "old", new Error("x"), Date.now() - 40 * 86400e3);
await O.opsFail(db, "trigger prune", new Error("y"));
ok("opsFail records and prunes > 30 days", db.raw.prepare("SELECT COUNT(*) n FROM ops_errors WHERE job='old'").get().n === 0 && db.raw.prepare("SELECT COUNT(*) n FROM ops_errors").get().n === 2);

for (const [src, type, c] of [["usage", "spend", -1], ["promo", "redeem", 10], ["revenuecat", "NON_RENEWING_PURCHASE", 5]])
  db.raw.prepare("INSERT INTO billing_events (id,user_id,source,event_id,type,credits_delta,created_at) VALUES (?,?,?,?,?,?,?)").run(crypto.randomUUID(), pat, src, crypto.randomUUID(), type, c, now);
const s = await O.ownerStats(db, env);
ok("paid purchases = real RevenueCat purchases only", s.paid.n === 1 && s.paid.credits === 5, s.paid);
ok("people counts", s.users.total === 2 && s.users.estimators === 1 && s.users.new7 === 2 && s.est.n7 === 2 && s.est.err7 === 1, s.users);
ok("label problems listed with the seller", s.labels.problems.length === 1 && s.labels.problems[0].email === "pat@example.com" && s.labels.payments[0].status === "stuck");
ok("job failures grouped", s.errors.jobs.find(j => j.job === "ebay order sync failed")?.n === 1);
who = "boss";
const page = await call("GET", "/owner");
ok("owner page renders", page.status === 200 && page.text.includes("Guestimator owner") && page.text.includes("pat@example.com") && page.text.includes("need a look"));
ok("text from the database is escaped", page.text.includes("Token Factory &lt;timeout&gt;") && page.text.includes("eBay 500 &lt;html&gt;") && !page.text.includes("<timeout>"));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

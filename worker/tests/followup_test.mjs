// Run:  node worker/tests/followup_test.mjs
// Answering the questions on an item is part of the same estimate: free. Any other re-run costs
// a credit as before. (The brass mouse, 2026-10-05: a question loop cost 5 credits on one item.)
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 400) : ""}`)); };
globalThis.fetch = async () => new Response("{}", { status: 404 });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const sent = [];
const env = { DB: db, NEBIUS_API_KEY: "x", PUBLIC_ORIGIN: "https://g.test", ASSETS: { fetch: async () => new Response("a") },
  APPRAISALS: { send: async m => { sent.push(m); } }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} } };
let cookie = "";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return { status: r.status, json: await r.json().catch(() => null) };
};
await call("POST", "/api/auth/register", { email: "q@example.com", password: "password123" });
const me = db.raw.prepare("SELECT id FROM users WHERE email='q@example.com'").get().id;
const item = (await call("POST", "/api/items", { name: "Mouse", description: "18 inch brass mouse" })).json.id;
db.raw.prepare("INSERT INTO photos (id,item_id,r2_key,kind,content_type,bytes,sort,created_at) VALUES ('p1',?,?,'front','image/jpeg',3,0,?)").run(item, item + "/a.jpg", new Date().toISOString());
const done = (nc, ago) => db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at,funded_by) VALUES (?,?,'done',?,?,'credit')")
  .run(crypto.randomUUID(), item, JSON.stringify({ confidence: 0.3, price_range: { low: 8, high: 32 }, needs_clarification: nc }), new Date(Date.now() - ago).toISOString());
db.raw.prepare("UPDATE users SET credits=0 WHERE id=?").run(me);

done({ reason: "unsure", questions: [{ q: "Solid or hollow?" }] }, 60e3);
let r = await call("POST", `/api/items/${item}/appraise`, { dealer_description: "18 inch brass mouse. Solid or hollow: Solid" });
ok("answering the questions is free (no credits needed)", r.status === 202 && r.json.funded_by === null, r);
ok("the run is queued", sent.length === 1);
ok("no credit taken", db.raw.prepare("SELECT credits FROM users WHERE id=?").get(me).credits === 0);

// The follow-up came back priced (no questions): another run is an ordinary paid re-run.
db.raw.prepare("UPDATE appraisals SET status='done', result_json=? WHERE id=?").run(JSON.stringify({ confidence: 0.8, price_range: { low: 8, high: 32 }, needs_clarification: null }), r.json.appraisal_id);
r = await call("POST", `/api/items/${item}/appraise`, {});
ok("re-running a priced item still costs a credit", r.status === 402 && r.json.paywall === true, r);

// An unknown result doesn't make re-runs free either.
db.raw.prepare("UPDATE appraisals SET result_json=? WHERE id=?").run(JSON.stringify({ confidence: 0.3, needs_clarification: null, unknown: { tries: 2 } }), r.json?.appraisal_id || "none");
done(null, -1000);
db.raw.prepare("UPDATE users SET credits=1 WHERE id=?").run(me);
r = await call("POST", `/api/items/${item}/appraise`, {});
ok("with a credit, a normal re-run charges it", r.status === 202 && r.json.funded_by === "credit" && db.raw.prepare("SELECT credits FROM users WHERE id=?").get(me).credits === 0, r);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

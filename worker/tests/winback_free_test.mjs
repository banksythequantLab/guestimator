// Run:  node worker/tests/winback_free_test.mjs
// One-time win-back with free estimates (owner page button, 2026-10-05), through the real routes:
// who is on the list, who can press it, what each person gets, and that it happens once.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as G from "../growth.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

globalThis.fetch = async () => new Response("{}", { status: 404 });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const mails = [], pending = [];
const VIDEO = "https://youtube.com/shorts/i4Mi9YwJobE";
const env = { DB: db, ASSETS: { fetch: async () => new Response("asset") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", EBAY_TOKEN_KEY: "k".repeat(32), ADMIN_EMAIL: "boss@example.com", DEMO_VIDEO_URL: VIDEO,
  EMAIL: { send: async m => { if (!/^Welcome to Guestimator/.test(m.subject)) mails.push(m); return { messageId: "m" }; } } };
const jar = {}; let who = "boss";
const call = async (method, path, body, headers = {}) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie: jar[who] || "", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil(p) { pending.push(p); } });
  while (pending.length) await pending.shift();
  const sc = r.headers.get("set-cookie"); if (sc) jar[who] = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const reg = async w => { who = w; return call("POST", "/api/auth/register", { email: `${w}@example.com`, password: "password123" }); };
const id = w => db.raw.prepare("SELECT id FROM users WHERE email=?").get(`${w}@example.com`).id;
const credits = w => db.raw.prepare("SELECT credits FROM users WHERE email=?").get(`${w}@example.com`).credits;
// An account from before estimates were free: no sign-up grant, nothing in the wallet.
const preFree = w => { db.raw.prepare("DELETE FROM billing_events WHERE user_id=? AND type='signup_free'").run(id(w)); db.raw.prepare("UPDATE users SET credits=0 WHERE id=?").run(id(w)); };

await reg("boss"); await reg("amy"); await reg("ben"); await reg("cal"); await reg("dan");
preFree("boss"); preFree("amy"); preFree("ben"); preFree("dan");      // cal signed up after: keeps his 5
who = "dan";
const item = (await call("POST", "/api/items", { name: "Brass lamp", description: "old brass lamp" })).json.id;
db.raw.prepare("INSERT INTO appraisals (id,item_id,status,created_at) VALUES (?,?,'done',?)").run(crypto.randomUUID(), item, new Date().toISOString());
db.raw.prepare("UPDATE gs_users SET marketing_off=1 WHERE user_id=?").run(id("ben"));   // unsubscribed

const list = (await G.winbackCandidates(env, db, "boss@example.com")).map(c => c.user_id);
ok("list: only pre-free accounts with no estimate, not unsubscribed, not the owner", JSON.stringify(list) === JSON.stringify([id("amy")]), list);

who = "boss";
const page = await call("GET", "/owner");
ok("owner page shows the list, the email preview and the funnel", page.status === 200 && page.text.includes("amy@example.com") && page.text.includes(`class="wb" value="${id("amy")}"`) && !page.text.includes(`class="wb" value="${id("cal")}"`)
  && page.text.includes("Your 5 free credits are ready") && page.text.includes(VIDEO) && page.text.includes("Sign-ups by week"));

ok("no custom header -> refused", (await call("POST", "/owner/winback", { ids: [id("amy")] })).status === 404 && credits("amy") === 0);
who = "cal";
ok("not the owner -> refused", (await call("POST", "/owner/winback", { ids: [id("amy")] }, { "x-gs-owner": "1" })).status === 404 && credits("amy") === 0);
who = "boss";
ok("nobody ticked -> nothing", (await call("POST", "/owner/winback", { ids: [] }, { "x-gs-owner": "1" })).status === 400);

mails.length = 0;
let r = await call("POST", "/owner/winback", { ids: [id("amy"), id("cal"), id("dan")] }, { "x-gs-owner": "1" });
ok("only listed people are touched, even if others are sent", r.status === 200 && r.json.sent === 1 && credits("cal") === 5 && credits("dan") === 0, { r: r.json, cal: credits("cal"), dan: credits("dan") });
ok("amy now has 5, in the ledger", credits("amy") === 5 && db.raw.prepare("SELECT SUM(credits_delta) n FROM billing_events WHERE user_id=? AND type='winback_free'").get(id("amy")).n === 5);
const m = mails.find(x => x.to === "amy@example.com");
ok("one email: free credits, the video, an unsubscribe link", mails.length === 1 && m && m.subject === "Your 5 free credits are ready"
  && m.text.includes("Now you start with 5 free credits. They're already in your account") && !/enough to price/.test(m.text) && m.text.includes(VIDEO) && m.text.includes("/api/growth/off?u="), m && m.text);

r = await call("POST", "/owner/winback", { ids: [id("amy")] }, { "x-gs-owner": "1" });
ok("once only", r.json.sent === 0 && credits("amy") === 5 && mails.length === 1);

// The automatic 3-day email: never to amy again, and not to a pre-free account with nothing in it.
await reg("eve"); preFree("eve");
const old = new Date(Date.now() - 5 * 86400e3).toISOString();
db.raw.prepare("UPDATE gs_users SET created_at=?").run(old);
mails.length = 0;
let s = await G.winbackSweep(env, db, "https://g.test");
const firsts = s.filter(x => x.kind === "first").map(x => x.user);
ok("3-day email skips amy (done) and eve (would hit the wall: she's for the button)", !firsts.includes(id("amy")) && !firsts.includes(id("eve")), firsts);
ok("cal gets it, saying his free credits are waiting, with the video", firsts.includes(id("cal")) && mails.some(x => x.to === "cal@example.com" && x.subject === "Your 5 free credits are waiting" && x.text.includes(VIDEO)), mails.map(x => [x.to, x.subject]));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

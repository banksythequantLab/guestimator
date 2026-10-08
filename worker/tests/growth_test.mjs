// Run:  node worker/tests/growth_test.mjs
// Referral links and win-back emails through the real routes and cron functions.
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
const env = { SIGNUP_CREDITS: "0", DB: db, ASSETS: { fetch: async () => new Response("asset") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", EBAY_TOKEN_KEY: "k".repeat(32),
  EMAIL: { send: async m => { if (!/^Welcome to Guestimator/.test(m.subject)) mails.push(m); return { messageId: "m" }; } } };
const jar = {}; let who = "amy";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie: jar[who] || "" },
    body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil(p) { pending.push(p); } });
  while (pending.length) await pending.shift();
  const sc = r.headers.get("set-cookie"); if (sc) jar[who] = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const reg = async w => { who = w; return call("POST", "/api/auth/register", { email: `${w}@example.com`, password: "password123" }); };
const id = w => db.raw.prepare("SELECT id FROM users WHERE email=?").get(`${w}@example.com`).id;
const credits = w => db.raw.prepare("SELECT credits FROM users WHERE email=?").get(`${w}@example.com`).credits;
const buy = (w, type = "NON_RENEWING_PURCHASE", env2 = "PRODUCTION") => db.raw.prepare("INSERT INTO billing_events (id,user_id,source,event_id,type,product_id,credits_delta,raw_json,created_at) VALUES (?,?,'revenuecat',?,?,'estimate_10',10,?,?)")
  .run(crypto.randomUUID(), id(w), crypto.randomUUID(), type, JSON.stringify({ environment: env2 }), new Date().toISOString());

// ---------- referrals ----------
await reg("amy");
let r = await call("GET", "/api/referral");
const code = r.json.code;
ok("personal link, stable code", r.status === 200 && /^[A-Z2-9]{7}$/.test(code) && r.json.link === `https://g.test/?ref=${code}` && r.json.credits === 5 && (await call("GET", "/api/referral")).json.code === code, r.json);
ok("config tells the sign-up screen the reward", (await call("GET", "/api/auth/config")).json.referral_credits === 5);
ok("can't claim your own link", (await call("POST", "/api/referral/claim", { code })).status === 400);
await reg("ben");
ok("bad code refused", (await call("POST", "/api/referral/claim", { code: "NOPE123" })).status === 404);
ok("new account claims the invite", (await call("POST", "/api/referral/claim", { code: code.toLowerCase() })).status === 200);
ok("only once", (await call("POST", "/api/referral/claim", { code })).status === 409);
await reg("cal");
db.raw.prepare("UPDATE users SET created_at=? WHERE email='cal@example.com'").run(new Date(Date.now() - 5 * 86400e3).toISOString());
ok("old accounts can't claim", (await call("POST", "/api/referral/claim", { code })).status === 409);
await reg("dee"); buy("dee");
ok("someone who already bought can't claim", (await call("POST", "/api/referral/claim", { code })).status === 409);

let out = await G.rewardSweep(env, db, "https://g.test");
ok("no reward for a sign-up alone", out.length === 0 && credits("amy") === 0 && credits("ben") === 0);
buy("ben", "NON_RENEWING_PURCHASE", "SANDBOX");
ok("sandbox purchase doesn't count", (await G.rewardSweep(env, db, "https://g.test")).length === 0);
buy("ben");
out = await G.rewardSweep(env, db, "https://g.test");
ok("first real purchase -> both get 5", out.length === 1 && credits("amy") === 5 && credits("ben") === 5, { out, a: credits("amy"), b: credits("ben") });
ok("both emailed", mails.some(m => m.to === "amy@example.com" && /invite worked/.test(m.subject)) && mails.some(m => m.to === "ben@example.com" && /free Guestimator credits/.test(m.subject)));
ok("ledger rows match the wallet", db.raw.prepare("SELECT SUM(credits_delta) s FROM billing_events WHERE source='referral'").get().s === 10);
buy("ben");
ok("never twice", (await G.rewardSweep(env, db, "https://g.test")).length === 0 && credits("amy") === 5);
who = "amy"; r = await call("GET", "/api/referral");
ok("referrer sees joined/rewarded", r.json.joined === 1 && r.json.rewarded === 1, r.json);
// monthly cap on the referrer
env.REFERRAL_MAX_PER_MONTH = "1";
await reg("eve"); await call("POST", "/api/referral/claim", { code }); buy("eve");
out = await G.rewardSweep(env, db, "https://g.test");
ok("over the monthly cap: friend still rewarded, referrer not", out[0]?.referrer_paid === false && credits("eve") === 5 && credits("amy") === 5, out);
delete env.REFERRAL_MAX_PER_MONTH;

// ---------- win-back ----------
mails.length = 0;
const now = Date.now(), ago = d => new Date(now - d * 86400e3).toISOString();
ok("sign-ups are Guestimator users", db.raw.prepare("SELECT COUNT(*) n FROM gs_users").get().n === 5);
db.raw.prepare("UPDATE gs_users SET created_at=?").run(ago(4));
db.raw.prepare("UPDATE gs_users SET created_at=? WHERE user_id=?").run(ago(1), id("eve"));   // too new
db.raw.prepare("UPDATE gs_users SET marketing_off=1 WHERE user_id=?").run(id("dee"));       // unsubscribed
// cal priced something 40 days ago and never listed it -> "waiting"; amy priced nothing
who = "cal";
const item = (await call("POST", "/api/items", { name: "Brass lamp", description: "old" })).json.id;
db.raw.prepare("INSERT INTO appraisals (id,item_id,status,created_at) VALUES (?,?,'done',?)").run(crypto.randomUUID(), item, ago(40));
let s = await G.winbackSweep(env, db, "https://g.test", now);
const firsts = s.filter(x => x.kind === "first").map(x => x.user).sort();
ok("first-estimate nudge: 3+ days, nothing priced, not unsubscribed", JSON.stringify(firsts) === JSON.stringify([id("amy"), id("ben")].sort()), s);
ok("gone-quiet email lists the waiting item", s.some(x => x.kind === "quiet" && x.user === id("cal")) && mails.some(m => m.to === "cal@example.com" && m.text.includes("Brass lamp")));
ok("every email has a working unsubscribe link", mails.length === 3 && mails.every(m => m.text.includes("/api/growth/off?u=") && m.html.includes("Unsubscribe")));
s = await G.winbackSweep(env, db, "https://g.test", now + 3600e3);
ok("once only", s.length === 0);
const link = mails.find(m => m.to === "amy@example.com").text.match(/https:\/\/g\.test(\/api\/growth\/off\?\S+)/)[1];
who = "nobody";
ok("unsubscribe link works without signing in", (await call("GET", link)).text.includes("No more reminder emails") && db.raw.prepare("SELECT marketing_off FROM gs_users WHERE user_id=?").get(id("amy")).marketing_off === 1);
ok("tampered link refused", (await call("GET", link.replace(/t=(\w)/, (_, c) => "t=" + (c === "0" ? "1" : "0")))).text.includes("isn't valid"));

// ---------- early 'ready to sell' nudge ----------
mails.length = 0;
await reg("fay");
const fi = (await call("POST", "/api/items", { name: "Oak cabinet", description: "two doors" })).json.id;
db.raw.prepare("INSERT INTO appraisals (id,item_id,status,created_at) VALUES (?,?,'done',?)").run(crypto.randomUUID(), fi, ago(5));
db.raw.prepare("UPDATE gs_users SET created_at=? WHERE user_id=?").run(ago(6), id("fay"));
await reg("gus");   // priced yesterday: too soon
const gi = (await call("POST", "/api/items", { name: "Tin toy", description: "" })).json.id;
db.raw.prepare("INSERT INTO appraisals (id,item_id,status,created_at) VALUES (?,?,'done',?)").run(crypto.randomUUID(), gi, ago(1));
s = await G.winbackSweep(env, db, "https://g.test", now);
ok("early nudge: priced 3-14 days ago, nothing listed", s.filter(x => x.kind === "early").map(x => x.user).join() === id("fay"), s);
const em = mails.find(m => m.to === "fay@example.com");
ok("names the item, says 0% Market, has unsubscribe", !!em && /Oak cabinet/.test(em.subject) && em.text.includes("0%") && em.text.includes("/api/growth/off?u="), em && em.subject);
ok("early nudge goes once", (await G.winbackSweep(env, db, "https://g.test", now + 7200e3)).filter(x => x.kind === "early").length === 0);
ok("not sent once it's listed on eBay", (() => { db.raw.prepare("UPDATE gs_users SET early_at=NULL WHERE user_id=?").run(id("fay")); try { db.raw.prepare("INSERT INTO ebay_listings (id,item_id,user_id,sku,status,created_at,updated_at) VALUES (?,?,?,'sku-fay','published',?,?)").run(crypto.randomUUID(), fi, id("fay"), ago(0), ago(0)); } catch (e) { console.log('listing insert', e.message); } return true; })()
  && (await G.winbackSweep(env, db, "https://g.test", now + 9000e3)).filter(x => x.kind === "early").length === 0);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Run: node worker/tests/freshen_test.mjs
// Price-guide refresh: due pages only, owner's only, daily cap, one at a time, weak refreshes never shown.
import { DatabaseSync } from "node:sqlite";
import { freshenOne, GOOD_REFRESH } from "../freshen.js";
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log("FAIL " + n + (got !== undefined ? "\n   got " + JSON.stringify(got) : ""))); };
const raw = new DatabaseSync(":memory:");
raw.exec(`CREATE TABLE users (id TEXT, email TEXT); CREATE TABLE sales (id TEXT, user_id TEXT);
  CREATE TABLE items (id TEXT, sale_id TEXT, guide_public INTEGER, guide_hidden INTEGER);
  CREATE TABLE appraisals (id TEXT, item_id TEXT, status TEXT, result_json TEXT, created_at TEXT, funded_by TEXT);`);
// D1-shaped wrapper
const db = { prepare: sql => { const st = raw.prepare(sql); let args = []; const o = { bind: (...a) => (args = a, o),
  first: async () => st.get(...args) ?? null, all: async () => ({ results: st.all(...args) }), run: async () => st.run(...args) }; return o; } };
const now = new Date("2026-12-20T12:00:00Z"), old = "2026-11-01T00:00:00Z", recent = "2026-12-10T00:00:00Z";
raw.exec(`INSERT INTO users VALUES ('me','dj@soltis.info'),('them','x@y.z'); INSERT INTO sales VALUES ('s1','me'),('s2','them');
  INSERT INTO items VALUES ('oldest','s1',1,NULL),('older','s1',1,NULL),('fresh','s1',1,NULL),('hidden','s1',1,1),('private','s1',NULL,NULL),('theirs','s2',1,NULL);`);
for (const [id, at] of [["oldest", "2026-10-01T00:00:00Z"], ["older", old], ["fresh", recent], ["hidden", "2026-09-01T00:00:00Z"], ["private", "2026-09-01T00:00:00Z"], ["theirs", "2026-09-01T00:00:00Z"]])
  raw.prepare("INSERT INTO appraisals VALUES (?,?,'done','{}',?,'credit')").run("a-" + id, id, at);
const sent = [];
const env = { PRICE_REFRESH_OWNER: "dj@soltis.info", PRICE_REFRESH_PER_DAY: "2", APPRAISALS: { send: async m => sent.push(m) } };
let r = await freshenOne(env, db, now);
ok("oldest due page of the owner first", r.started === "oldest" && sent.length === 1 && sent[0].itemId === "oldest", r);
ok("refresh row is pending, funded_by refresh", raw.prepare("SELECT COUNT(*) n FROM appraisals WHERE item_id='oldest' AND status='pending' AND funded_by='refresh'").get().n === 1);
r = await freshenOne(env, db, now);
ok("one at a time", r.skipped === "busy", r);
raw.exec("UPDATE appraisals SET status='done' WHERE funded_by='refresh'");
r = await freshenOne(env, db, now);
ok("next due page", r.started === "older", r);
raw.exec("UPDATE appraisals SET status='done' WHERE funded_by='refresh'");
r = await freshenOne(env, db, now);
ok("daily cap", r.skipped === "cap", r);
r = await freshenOne(env, db, new Date("2026-12-21T12:00:00Z"));
ok("never: fresh, hidden, private or someone else's", r.skipped === "none due", r);
ok("off without owner", (await freshenOne({ ...env, PRICE_REFRESH_OWNER: "" }, db, now)).skipped === "off");
ok("off at cap 0", (await freshenOne({ ...env, PRICE_REFRESH_PER_DAY: "0" }, db, now)).skipped === "off");
// a weak refresh never replaces the page
raw.exec(`INSERT INTO appraisals VALUES ('good-old','w','done','{"confidence":0.9,"sold_market":{"count":4}}','2026-10-01T00:00:00Z','credit'),
  ('weak-new','w','done','{"thin_evidence":true,"confidence":0.4,"sold_market":{"count":1}}','2026-12-01T00:00:00Z','refresh'),
  ('good-new','v','done','{"thin_evidence":false,"confidence":0.85,"sold_market":{"count":3}}','2026-12-01T00:00:00Z','refresh'),
  ('good-oldv','v','done','{"confidence":0.9,"sold_market":{"count":4}}','2026-10-01T00:00:00Z','credit')`);
const pick = item => raw.prepare(`SELECT id FROM appraisals x WHERE x.item_id=? AND x.status='done' AND ${GOOD_REFRESH("x")} ORDER BY x.created_at DESC LIMIT 1`).get(item).id;
ok("weak refresh skipped, older page stays", pick("w") === "good-old", pick("w"));
ok("good refresh replaces it", pick("v") === "good-new", pick("v"));
console.log(`freshen: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

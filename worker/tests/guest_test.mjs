// Run: node worker/tests/guest_test.mjs
// Try before sign-up (2026-10-12): guest accounts, their limits, upgrading, adopting, the funnel.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };
globalThis.fetch = async () => new Response("{}", { status: 404 });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const mails = [];
const env = { DB: db, ASSETS: { fetch: async () => new Response("asset") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  NEBIUS_API_KEY: "test", PUBLIC_ORIGIN: "https://g.test", ADMIN_EMAIL: "boss@example.com", SIGNUP_CREDITS: "5", EMAIL: { send: async m => { mails.push(m); return { messageId: "m" }; } } };
const call = async (method, path, body, cookie = "", ip = "1.1.1.1") => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie, "cf-connecting-ip": ip },
    body: body === undefined || method === "GET" ? undefined : JSON.stringify(body) }), env, { waitUntil(p) { return p; } });
  const sc = r.headers.get("set-cookie"); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, cookie: sc ? sc.split(";")[0] : null };
};
const userCount = () => db.raw.prepare("SELECT COUNT(*) n FROM users").get().n;

// a guest
const g = await call("POST", "/api/auth/guest", undefined, "gs_src=" + encodeURIComponent("zeely|free_guestimate"));
ok("guest account made, cookie set", g.status === 200 && g.json.guest === true && !!g.cookie, g);
{ const raw = await worker.fetch(new Request("https://g.test/api/auth/guest", { method: "POST", headers: { "cf-connecting-ip": "9.9.9.9" } }), env, { waitUntil() {} });
  const sc = raw.headers.getSetCookie ? raw.headers.getSetCookie() : [raw.headers.get("set-cookie")];
  ok("guest also gets a claim cookie only the Google endpoint can read", sc.some(c => /^bt_session=.*SameSite=Lax/.test(c)) && sc.some(c => /^gs_guest=.*SameSite=None.*Path=\/api\/auth\/google/.test(c)), sc);
  const last = db.raw.prepare("SELECT user_id FROM guest_starts ORDER BY rowid DESC LIMIT 1").get().user_id;
  for (const q of ["DELETE FROM sessions WHERE user_id=?", "DELETE FROM guest_starts WHERE user_id=?", "DELETE FROM users WHERE id=?"]) db.raw.prepare(q).run(last); }
const gc = g.cookie + "; gs_src=" + encodeURIComponent("zeely|free_guestimate");
const gid = db.raw.prepare("SELECT id FROM users WHERE email LIKE '%@guest.invalid'").get().id;
const grow = db.raw.prepare("SELECT credits, signup_source s FROM users WHERE id=?").get(gid);
ok("guest has 1 credit and its ad source", grow.credits === 1 && grow.s === "zeely", grow);
ok("me says guest, no email", (await call("GET", "/api/auth/me", undefined, gc)).json.guest === true);
ok("again with a session: no second guest", (await call("POST", "/api/auth/guest", undefined, gc)).json.existing === true && userCount() === 1);

// what a guest can and can't do
const it = await call("POST", "/api/items", { name: "Oak cabinet", description: "Painted" }, gc);
ok("guest can add an item", it.status === 200 && !!it.json.id, it);
ok("and list their items", (await call("GET", "/api/items", undefined, gc)).json.length === 1);
for (const [m, p] of [["GET", "/api/garage/sales"], ["GET", "/api/ebay/status"], ["POST", "/api/feedback"], ["POST", `/api/items/${it.json.id}/share`], ["POST", `/api/items/${it.json.id}/ebay/draft`], ["POST", "/api/referral/claim"]]) {
  const r = await call(m, p, {}, gc);
  ok(`guest blocked: ${m} ${p}`, r.status === 403 && r.json.needs_account === true, r);
}
db.raw.prepare("UPDATE users SET credits=0 WHERE id=?").run(gid);
db.raw.prepare("INSERT INTO photos (id,item_id,r2_key,kind,content_type,bytes,sort,created_at) VALUES (?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), it.json.id, it.json.id + "/a.jpg", "front", "image/jpeg", 10, 0, new Date().toISOString());
const out = await call("POST", `/api/items/${it.json.id}/appraise`, {}, gc);
ok("guest out of credits -> sign up, not the paywall", out.status === 402 && out.json.needs_account === true && !out.json.paywall, out);
db.raw.prepare("UPDATE users SET credits=1 WHERE id=?").run(gid);

// no email to guests
const { sendAlert } = await import("../notify.js");
ok("no email to a guest address", (await sendAlert(env, { to: `guest-${gid}@guest.invalid`, subject: "x", text: "y" })).sent === false && !mails.length);

// owner page doesn't count guests as sign-ups
const own = await import("../owner.js");
let st = await own.ownerStats(db, env, Date.now());
ok("owner: guest is not a user, is a guest try", Number(st.users.total) === 0 && Number(st.users.guests7) === 1, st.users);

// sign up: the guest row becomes the account
const up = await call("POST", "/api/auth/register", { email: "new@example.com", password: "password123" }, gc);
const urow = db.raw.prepare("SELECT id, credits, signup_source s FROM users WHERE email='new@example.com'").get();
ok("register upgrades the guest: same id, item kept, topped up to 5", up.status === 200 && up.json.upgraded === true && urow.id === gid && urow.credits === 5 && urow.s === "zeely" && userCount() === 1, { up: up.json, urow });
ok("new account owns the item", (await call("GET", "/api/items", undefined, up.cookie)).json.length === 1);
st = await own.ownerStats(db, env, Date.now());
ok("owner: now one real sign-up", Number(st.users.total) === 1, st.users);

// a guest who already has an account signs in: items move over, guest row goes
const g2 = await call("POST", "/api/auth/guest", undefined, "", "2.2.2.2");
const it2 = await call("POST", "/api/items", { name: "Lamp" }, g2.cookie);
const g2id = db.raw.prepare("SELECT id FROM users WHERE email LIKE '%@guest.invalid'").get().id;
const li = await call("POST", "/api/auth/login", { email: "new@example.com", password: "password123" }, g2.cookie);
ok("login adopts the guest's item", li.status === 200 && (await call("GET", "/api/items", undefined, li.cookie)).json.length === 2 && !db.raw.prepare("SELECT 1 FROM users WHERE id=?").get(g2id), it2.json);

// caps: 3 guests per network a day
for (let i = 0; i < 2; i++) await call("POST", "/api/auth/guest", undefined, "", "3.3.3.3");
const third = await call("POST", "/api/auth/guest", undefined, "", "3.3.3.3");
const fourth = await call("POST", "/api/auth/guest", undefined, "", "3.3.3.3");
ok("3 per network per day, then sign-up", third.status === 200 && fourth.status === 429 && fourth.json.needs_account === true, fourth);
env.GUEST_DAILY_CAP = "1";
ok("daily cap", (await call("POST", "/api/auth/guest", undefined, "", "4.4.4.4")).status === 429);
delete env.GUEST_DAILY_CAP;

// funnel events
const hit = (b) => worker.fetch(new Request("https://g.test/hit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }), env, { waitUntil() {} });
await hit({ s: "zeely", c: "free_guestimate", sid: "v1", e: "land" });
await hit({ s: "zeely", c: "free_guestimate", sid: "v1", e: "try_click" });
await hit({ s: "zeely", c: "free_guestimate", sid: "v2", e: "land" });
await hit({ s: "zeely", c: "free_guestimate", sid: "v2", e: "bogus" });
const rows = db.raw.prepare("SELECT ev, sid FROM landing_hits ORDER BY rowid").all();
ok("events stored with session id; unknown event counts as a landing", rows.length === 4 && rows[1].ev === "try_click" && rows[3].ev === "land", rows);
st = await own.ownerStats(db, env, Date.now());
ok("owner funnel: 2 landed, 1 tried", st.funnelSteps.zeely && st.funnelSteps.zeely.land === 2 && st.funnelSteps.zeely.try_click === 1, st.funnelSteps);
const page = await call("GET", "/owner", undefined, (await call("POST", "/api/auth/register", { email: "boss@example.com", password: "password123" })).cookie);
ok("owner page shows the step table", page.status === 200);
ok("owner: last 24 hours counts visits and guest tries", st.day && st.day.visits === 2 && st.day.guests >= 3 && Array.isArray(st.day.ests) && st.day.signups.length >= 1, st.day);
{ const html = (await worker.fetch(new Request("https://g.test/owner", { headers: { cookie: (await call("POST", "/api/auth/login", { email: "boss@example.com", password: "password123" })).cookie } }), env, { waitUntil() {} })).status === 200
    ? await (await worker.fetch(new Request("https://g.test/owner", { headers: { cookie: (await call("POST", "/api/auth/login", { email: "boss@example.com", password: "password123" })).cookie } }), env, { waitUntil() {} })).text() : "";
  ok("owner page has the Last 24 hours section", html.includes("Last 24 hours") && html.includes("Tried free"), html.slice(0, 200)); }

// the landing page's real example: best-evidenced price-guide entry, or none
{ const ex = await call("GET", "/api/public/example");
  ok("example endpoint answers (none yet in an empty guide)", ex.status === 200 && ex.json.example === null, ex.json); }
// short email links
{ const go = async c => (await worker.fetch(new Request("https://g.test/t/" + c), env, { waitUntil() {} }));
  const a = await go("pa"), z = await go("nope"), h = await go("hasOwnProperty");
  ok("/t/pa -> tagged landing link", a.status === 302 && a.headers.get("location") === "/?utm_source=terry&utm_medium=email&utm_campaign=pos-antique", a.headers.get("location"));
  ok("unknown short code -> plain home", z.status === 302 && z.headers.get("location") === "/" && h.headers.get("location") === "/"); }
console.log(`guest_test: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

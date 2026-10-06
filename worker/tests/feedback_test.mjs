// Run:  node worker/tests/feedback_test.mjs
// In-app feedback (2026-10-06): send, see your own with its status, owner works the list on
// /owner (planned/done emails the sender once), limits; plus the appearance shell (index.html).
import { d1 } from "./d1shim.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

globalThis.fetch = async () => new Response("{}", { status: 404 });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const mails = [], pending = [];
const env = { DB: db, ASSETS: { fetch: async () => new Response("asset") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", ADMIN_EMAIL: "boss@example.com", EMAIL: { send: async m => { mails.push(m); return { messageId: "m" + mails.length }; } } };
const jar = { sam: "", boss: "", anon: "" }; let who = "sam";
const call = async (method, path, body, headers = {}) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie: jar[who], ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil(p) { pending.push(p); } });
  while (pending.length) await pending.shift().catch(() => {});
  const sc = r.headers.get("set-cookie"); if (sc && who !== "anon") jar[who] = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
await call("POST", "/api/auth/register", { email: "sam@example.com", password: "password123" });
who = "boss"; await call("POST", "/api/auth/register", { email: "boss@example.com", password: "password123" }); who = "sam";

// ---------- send ----------
mails.length = 0;
let r = await call("POST", "/api/feedback", { kind: "idea", message: "Let me pick two shipping options", page: "home", version: "8.0" });
ok("send: ok", r.status === 200 && r.json.ok && r.json.id, r.json);
const fid = r.json.id;
const m0 = mails.find(m => m.to === "boss@example.com");
ok("owner emailed, reply goes to the sender", m0 && m0.replyTo === "sam@example.com" && /feedback \(Idea\)/.test(m0.subject) && m0.text.includes("two shipping options") && m0.text.includes("screen: home"), m0);
ok("stored with screen and version", (() => { const f = db.raw.prepare("SELECT * FROM feedback WHERE id=?").get(fid); return f.page === "home" && f.app_version === "8.0" && f.status === "new" && f.kind === "idea"; })());
ok("too short refused", (await call("POST", "/api/feedback", { kind: "bug", message: "x" })).status === 400);
ok("unknown kind becomes other", (await call("POST", "/api/feedback", { kind: "rant", message: "something else entirely" })).status === 200 &&
  db.raw.prepare("SELECT kind FROM feedback ORDER BY created_at DESC LIMIT 1").get().kind === "other");
who = "anon"; ok("signed-out: refused", (await call("POST", "/api/feedback", { message: "hello there" })).status === 401); who = "sam";

// ---------- yours ----------
r = await call("GET", "/api/feedback/mine");
ok("see your own", r.status === 200 && r.json.items.length === 2 && r.json.items.some(i => i.id === fid && i.status === "new"));
who = "boss"; ok("not someone else's", (await call("GET", "/api/feedback/mine")).json.items.length === 0);

// ---------- owner ----------
r = await call("GET", "/owner");
ok("owner page lists it", r.status === 200 && r.text.includes("Feedback (2 new)") && r.text.includes("Let me pick two shipping options") && r.text.includes("sam@example.com"));
ok("owner POST needs the page header", (await call("POST", "/owner/feedback", { id: fid, status: "planned" })).status === 404);
mails.length = 0;
r = await call("POST", "/owner/feedback", { id: fid, status: "planned", note: "Building it this week" }, { "x-gs-owner": "1" });
ok("planned: saved and sender emailed", r.status === 200 && r.json.emailed === true && mails[0].to === "sam@example.com" && /on our list/.test(mails[0].subject) && mails[0].text.includes("Building it this week"), r.json);
mails.length = 0;
r = await call("POST", "/owner/feedback", { id: fid, status: "planned", note: "Building it this week, promise" }, { "x-gs-owner": "1" });
ok("same status again: no second email", r.status === 200 && r.json.emailed === false && mails.length === 0);
r = await call("POST", "/owner/feedback", { id: fid, status: "done" }, { "x-gs-owner": "1" });
ok("done: emailed once more, note kept", r.json.emailed === true && /is live/.test(mails[0].subject) && mails[0].text.includes("promise"));
ok("bad status refused", (await call("POST", "/owner/feedback", { id: fid, status: "maybe" }, { "x-gs-owner": "1" })).status === 400);
who = "sam";
ok("not the owner: 404", (await call("POST", "/owner/feedback", { id: fid, status: "declined" }, { "x-gs-owner": "1" })).status === 404);
r = await call("GET", "/api/feedback/mine");
ok("sender sees Done and the note", r.json.items.find(i => i.id === fid).status === "done" && r.json.items.find(i => i.id === fid).owner_note === "Building it this week, promise");

// ---------- limit ----------
for (let i = 0; i < 8; i++) await call("POST", "/api/feedback", { kind: "idea", message: "idea number " + i });
ok("10 a day", (await call("POST", "/api/feedback", { kind: "idea", message: "one too many" })).status === 429);

// ---------- appearance shell ----------
const html = readFileSync(join(here, "..", "public", "index.html"), "utf8");
ok("appearance applied before paint", html.indexOf("window.gsLook") > 0 && html.indexOf("window.gsLook") < html.indexOf("<style>"));
ok("forced dark, black & white light and dark", html.includes(":root[data-theme=dark]{") && html.includes(":root[data-skin=mono]{") && html.includes(":root[data-skin=mono][data-theme=dark]{"));
ok("buttons use the readable text color", html.includes(".btn{background:var(--green);color:var(--on-accent);"));
ok("look.js loaded before app.js", html.indexOf("/look.js") > 0 && html.indexOf("/look.js") < html.indexOf("/app.js"));
// gsLook itself, in a fake document
{
  const attrs = {}, props = {};
  const d = { setAttribute: (k, v) => attrs[k] = v, removeAttribute: k => delete attrs[k], style: { setProperty: (k, v) => props[k] = v, removeProperty: k => delete props[k] } };
  const g = { document: { documentElement: d, querySelector: () => null }, matchMedia: () => ({ matches: false }), localStorage: { getItem: () => null } };
  g.window = g;
  const src = html.slice(html.indexOf("window.gsLook"), html.indexOf("try { gsLook"));
  new Function("window", "document", "matchMedia", src)(g, g.document, g.matchMedia);
  g.gsLook({ mode: "dark", skin: "mono", accent: "#ffd400" });
  ok("gsLook: dark + mono + yellow highlight", attrs["data-theme"] === "dark" && attrs["data-skin"] === "mono" && props["--green"] === "#ffd400" && props["--on-accent"] === "#000", { attrs, props });
  g.gsLook({ mode: "dark", skin: "mono", accent: "#1e1b4b" });
  ok("gsLook: dark highlight lightened for links on black", props["--cobalt"] !== "#1e1b4b" && props["--on-accent"] === "#fff", props);
  g.gsLook({ mode: "system", skin: "classic" });
  ok("gsLook: back to classic clears overrides", !attrs["data-theme"] && !attrs["data-skin"] && !props["--green"]);
}

console.log(`feedback_test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

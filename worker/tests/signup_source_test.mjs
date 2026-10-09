// Run: node worker/tests/signup_source_test.mjs
// Sign-up source (2026-10-07, before the first paid ads): the first-touch gs_src cookie is saved on the new account.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };
globalThis.fetch = async () => new Response("{}", { status: 404 });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, ASSETS: { fetch: async () => new Response("asset") }, PUBLIC_ORIGIN: "https://g.test", EMAIL: { send: async () => ({ messageId: "m" }) } };
const reg = (email, cookie) => worker.fetch(new Request("https://g.test/api/auth/register", { method: "POST",
  headers: { "content-type": "application/json", cookie: cookie || "" }, body: JSON.stringify({ email, password: "password123" }) }), env, { waitUntil() {} });
const row = email => db.raw.prepare("SELECT signup_source s, signup_campaign c FROM users WHERE email=?").get(email);
ok("ad click is recorded with its campaign", (await reg("a@example.com", "x=1; gs_src=" + encodeURIComponent("zeely|free_guestimate"))).status < 300 && row("a@example.com").s === "zeely" && row("a@example.com").c === "free_guestimate", row("a@example.com"));
await reg("b@example.com", "gs_src=" + encodeURIComponent("reddit.com|"));
ok("referring site, no campaign", row("b@example.com").s === "reddit.com" && row("b@example.com").c === null, row("b@example.com"));
await reg("c@example.com", "");
ok("no cookie -> unknown (null)", row("c@example.com").s === null);
await reg("d@example.com", "gs_src=" + encodeURIComponent("Ev<il>'; DROP|x y"));
ok("junk is cleaned, not stored raw", row("d@example.com").s === "evildrop" && row("d@example.com").c === "xy", row("d@example.com"));
// utm_content rides along in the campaign (2026-10-08: two Zeely campaigns, image vs. video)
await reg("e@example.com", "gs_src=" + encodeURIComponent("zeely|free_guestimate|presenter_video"));
ok("ad content kept with the campaign", row("e@example.com").c === "free_guestimate-presenter_video", row("e@example.com"));
// Visits from tagged links, signed up or not
const hit = (body, ua) => worker.fetch(new Request("https://g.test/hit", { method: "POST", headers: { "content-type": "application/json", "user-agent": ua || "Mozilla/5.0" }, body: JSON.stringify(body) }), env, { waitUntil() {} });
const h1 = await hit({ s: "zeely", c: "free_guestimate", t: "presenter_video" }, "Mozilla/5.0 (iPhone) [FBAN/FBIOS;FBAV/450.0]");
await hit({ s: "price_guide" });
await hit({ s: "" });
await hit({ s: "Ev<il>", c: "'; DROP" });
const hits = db.raw.prepare("SELECT src, camp, content, inapp FROM landing_hits ORDER BY rowid").all();
ok("hit answers 204", h1.status === 204);
ok("tagged arrival stored with in-app flag", hits[0] && hits[0].src === "zeely" && hits[0].content === "presenter_video" && hits[0].inapp === 1, hits[0]);
ok("plain browser not in-app; empty source ignored; junk cleaned", hits.length === 3 && hits[1].inapp === 0 && hits[2].src === "evil" && hits[2].camp === "drop", hits);
const own = await import("../owner.js");
const st = await own.ownerStats(db, env, Date.now());
ok("owner stats list visits by source", (st.visits || []).some(v => v.src === "zeely" && v.n === 1 && v.inapp === 1), st.visits);
console.log(`signup_source_test: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
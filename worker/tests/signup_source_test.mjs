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
console.log(`signup_source_test: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
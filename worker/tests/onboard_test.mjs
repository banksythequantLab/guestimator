// Run:  node worker/tests/onboard_test.mjs
// Welcome email on a new Guestimator account; none on sign-in or a duplicate sign-up.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { welcomeEmail, WELCOME_STEPS } from "../onboard.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

globalThis.fetch = async () => new Response("{}", { status: 404 });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const mails = [], pending = [];
const env = { DB: db, ASSETS: { fetch: async () => new Response("asset") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", EMAIL: { send: async m => { mails.push(m); return { messageId: "m" }; } } };
const call = async (path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env, { waitUntil(p) { pending.push(p); } });
  while (pending.length) await pending.shift();
  return r.status;
};

ok("sign-up works", await call("/api/auth/register", { email: "New@Example.com", password: "password123" }) === 200);
ok("one welcome email to the new seller", mails.length === 1 && mails[0].to === "new@example.com" && /Welcome to Guestimator/.test(mails[0].subject), mails.map(m => [m.to, m.subject]));
ok("it has the steps and the link, no reply promise without SUPPORT_EMAIL", WELCOME_STEPS.every(([, t]) => mails[0].text.includes(t)) && mails[0].text.includes("https://g.test/") && !/reply to this email/i.test(mails[0].text) && !mails[0].replyTo);
ok("no free-estimate promise (Derek: no free estimate)", !/free estimate|free guestimate/i.test(mails[0].text) && /use credits/.test(mails[0].text));
ok("5 free credits granted at sign-up, in the ledger", db.raw.prepare("SELECT credits FROM users WHERE email='new@example.com'").get().credits === 5 && db.raw.prepare("SELECT SUM(credits_delta) n FROM billing_events b JOIN users u ON u.id=b.user_id WHERE u.email='new@example.com' AND b.type='signup_free'").get().n === 5);
await call("/api/auth/login", { email: "new@example.com", password: "password123" });
await call("/api/auth/register", { email: "new@example.com", password: "password123" });
ok("no email on sign-in or a duplicate sign-up", mails.length === 1);
mails.length = 0;
await welcomeEmail({ ...env, SUPPORT_EMAIL: "help@theguestimator.com" }, "a@b.c", "https://g.test");
ok("with SUPPORT_EMAIL: reply-to set and offered", mails[0].replyTo === "help@theguestimator.com" && /reply to this email/i.test(mails[0].text));

ok("no demo link when DEMO_VIDEO_URL is unset", !/30 seconds/.test(mails[0].text));
mails.length = 0;
await welcomeEmail({ ...env, DEMO_VIDEO_URL: "https://youtube.com/shorts/i4Mi9YwJobE" }, "a@b.c", "https://g.test");
ok("demo Short linked in text and html", mails[0].text.includes("See it work in 30 seconds: https://youtube.com/shorts/i4Mi9YwJobE") && mails[0].html.includes('href="https://youtube.com/shorts/i4Mi9YwJobE"'));
mails.length = 0;
await welcomeEmail({ ...env, DEMO_VIDEO_URL: "javascript:alert(1)" }, "a@b.c", "https://g.test");
ok("a non-YouTube link is never sent", !/javascript:|30 seconds/.test(mails[0].text + mails[0].html));
const cfg = await (await worker.fetch(new Request("https://g.test/api/auth/config"), { ...env, DEMO_VIDEO_URL: "https://youtube.com/shorts/i4Mi9YwJobE" }, { waitUntil() {} })).json();
ok("config hands the app the demo link", cfg.demo_video === "https://youtube.com/shorts/i4Mi9YwJobE", cfg);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

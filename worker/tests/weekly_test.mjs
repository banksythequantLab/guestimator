// Run:  node worker/tests/weekly_test.mjs
// Weekly selling summary through the REAL scheduled() and routes. Proves who gets it, when, what
// it says, the once-a-week gate and the signed opt-out - NOT how it renders in a mail client.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as W from "../weekly.js";
import { seal } from "../ebay.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 700) : ""}`)); };

const MON = Date.parse("2026-10-05T13:20:00Z"), SUN = Date.parse("2026-10-04T13:20:00Z"), MON_EARLY = Date.parse("2026-10-05T09:00:00Z");
ok("send window: Monday from 13:00 UTC only", W.inSendWindow(MON) && !W.inSendWindow(SUN) && !W.inSendWindow(MON_EARLY));

globalThis.fetch = async u => new Response(JSON.stringify({ orders: [] }), { status: 200, headers: { "content-type": "application/json" } });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const mails = [];
const env = { DB: db, ASSETS: { fetch: async () => new Response("a") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", EBAY_CLIENT_ID: "c", EBAY_CLIENT_SECRET: "s", EBAY_RUNAME: "R",
  EBAY_TOKEN_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 5)).toString("base64"),
  EMAIL: { send: async m => { if (/^Welcome to Guestimator/.test(m.subject)) return { messageId: "w" };   // sign-up welcome isn't what this test checks
    mails.push(m); return { messageId: "m" }; } } };
let cookie = "";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const t = await r.text(); let json = null; try { json = JSON.parse(t); } catch {}
  return { status: r.status, json, text: t };
};
await call("POST", "/api/auth/register", { email: "d@example.com", password: "password123" });
const me = db.raw.prepare("SELECT id FROM users WHERE email='d@example.com'").get().id;
const t0 = new Date(MON - 20 * 86400e3).toISOString();
db.raw.prepare("INSERT INTO ebay_accounts (user_id,ebay_user_id,ebay_username,refresh_token_enc,access_token_enc,access_expires_at,orders_synced_at,fulfillment_ok,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)")
  .run(me, "EU1", "d", await seal(env, "REF"), await seal(env, "ACC"), new Date(Date.now() + 3600e3).toISOString(), new Date().toISOString(), t0, t0);
const mk = async (name, cents, extra = {}) => {
  const id = (await call("POST", "/api/items", { name, description: name })).json.id;
  db.raw.prepare("UPDATE items SET listing_status='live', price_cents=? WHERE id=?").run(cents, id);
  db.raw.prepare("INSERT INTO ebay_listings (id,item_id,user_id,sku,status,offer_id,listing_url,price_cents,created_at,updated_at,best_offer_accept_cents,best_offer_decline_cents,sold_count,sold_median_cents) VALUES (?,?,?,?,'published',?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), id, me, "S-" + name, "O-" + name, "https://www.ebay.com/itm/" + name, cents, t0, t0, extra.acc ?? null, extra.dec ?? null, extra.n ?? null, extra.med ?? null);
  return id;
};
await mk("Cisco", 19900, { acc: 17900, dec: 11500, n: 4, med: 12000 });
await mk("Tesla", 8500, { n: 20, med: 8500 });
const sold = await mk("Hynix", 9500);
db.raw.prepare("UPDATE items SET listing_status='sold' WHERE id=?").run(sold);
db.raw.prepare("INSERT INTO ebay_orders (id,user_id,order_id,line_item_id,item_id,status,total_cents,ordered_at,created_at,updated_at) VALUES (?,?,?,'L1',?,'FULFILLED',?,?,?,?)")
  .run(crypto.randomUUID(), me, "12-1", sold, 9500, new Date(MON - 2 * 86400e3).toISOString(), t0, t0);

// ---------- content ----------
const sum = await W.weeklySummary(db, me, MON);
ok("summary: the sale this week and the two live listings", sum.sold.length === 1 && sum.sold[0].sale_cents === 9500 && sum.listings.length === 2, sum);
const c = sum.listings.find(l => /Cisco/.test(l.title));
ok("summary: Cisco above recent sales with a suggestion; offers carried", c.verdict === "high" && c.suggested_cents === 12000 && c.offers.decline_cents === 11500, c);
ok("summary: Tesla in line", sum.listings.find(l => /Tesla/.test(l.title)).verdict === "ok");
{ const x = W.weeklyEmail({ ...sum, listings: [{ ...c, verdict: "none" }, { ...c, verdict: "unknown" }] }, "o", "x").text;
  ok("checked-and-none reads differently from never checked", /no recent eBay sales of this found/.test(x) && /not price-checked yet/.test(x), x); }
const em = W.weeklyEmail(sum, "https://g.test", "https://g.test/off");
ok("email: subject counts the week", em.subject === "This week: 1 sold, $95.00", em.subject);
ok("email: listing lines say price, verdict and offers", /Cisco: \$199\.00, 20 days listed, about 66% above the \$120\.00 median of 4 recent sales\. Try \$120\.00\. Offers on \(\$179\.00\+ accepted, under \$115\.00 declined\)\./.test(em.text), em.text);
ok("email: has the review link and the opt-out", em.text.includes("https://g.test/#ebay-orders") && em.html.includes("https://g.test/off"));
ok("email: html is escaped", !/<script/.test(W.weeklyEmail({ ...sum, listings: [{ ...c, title: "<script>x</script>" }] }, "o", "x").html));

// ---------- sending ----------
let r = await W.emailWeekly(env, db, "https://g.test", { nowMs: SUN });
ok("not sent outside the window", r.sent === 0 && mails.length === 0);
r = await W.emailWeekly(env, db, "https://g.test", { nowMs: MON });
ok("sent on Monday", r.sent === 1 && mails.length === 1 && mails[0].to === "d@example.com", r);
r = await W.emailWeekly(env, db, "https://g.test", { nowMs: MON + 15 * 60e3 });
ok("once a week, not every tick", r.sent === 0 && mails.length === 1);
r = await W.emailWeekly(env, db, "https://g.test", { nowMs: MON + 7 * 86400e3 });
ok("again next Monday", r.sent === 1 && mails.length === 2);

// ---------- opt-out ----------
const link = await W.offLink(env, "https://g.test", me);
const bad = await call("GET", link.replace("https://g.test", "").replace(/t=[0-9a-f]+/, "t=deadbeef"));
ok("a forged opt-out link does nothing", /isn.t valid/.test(bad.text) && !db.raw.prepare("SELECT weekly_off o FROM seller_settings WHERE user_id=?").get(me).o);
const good = await call("GET", link.replace("https://g.test", ""));
ok("the real link turns it off", /won.t get the weekly/.test(good.text) && db.raw.prepare("SELECT weekly_off o FROM seller_settings WHERE user_id=?").get(me).o === 1);
r = await W.emailWeekly(env, db, "https://g.test", { nowMs: MON + 14 * 86400e3 });
ok("no more after opting out", r.sent === 0 && mails.length === 2);

// ---------- preview to myself ----------
r = await call("POST", "/api/weekly/preview");
ok("preview sends now to me, even opted out", r.status === 200 && r.json.sent === true && mails.length === 3 && mails[2].to === "d@example.com", r.json);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
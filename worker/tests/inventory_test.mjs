// Run: node worker/tests/inventory_test.mjs
// Inventory reports (2026-11-19): create, add items (cap), checkout, finish grants the allowance once, print view
// only when paid, landing page wording, sitemap.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as INV from "../inventory.js";
import * as P from "../priceguide.js";
const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 600) : ""}`)); };
const jr = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
// Stripe stub: checkout opens; the session reads unpaid until we flip it.
let paidState = "unpaid"; const stripeCalls = [];
globalThis.fetch = async (u, init = {}) => {
  const url = String(u);
  if (url.includes("api.stripe.com")) { stripeCalls.push({ url, body: init.body }); if (url.endsWith("/v1/checkout/sessions")) return jr({ id: "cs_test_1", url: "https://checkout.stripe.test/pay" }); if (url.includes("/v1/checkout/sessions/cs_test_1")) return jr({ id: "cs_test_1", payment_status: paidState === "paid" ? "paid" : "unpaid", status: paidState === "expired" ? "expired" : "open", payment_intent: "pi_1" }); }
  return jr({}, 404);
};
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, ASSETS: { fetch: async () => new Response("asset") }, PUBLIC_ORIGIN: "https://g.test", EMAIL: { send: async () => ({}) }, STRIPE_SECRET_KEY: "sk_test", NEBIUS_API_KEY: "k" };
const now = new Date().toISOString();
db.raw.prepare("INSERT INTO users (id,email,pw_hash,pw_salt,created_at,credits) VALUES ('u1','a@b.c','h','s',?,1)").run(now);
db.raw.prepare("INSERT INTO users (id,email,pw_hash,pw_salt,created_at,credits) VALUES ('u2','x@y.z','h','s',?,1)").run(now);
db.raw.prepare("INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES ('tok1','u1',?,'2099-01-01')").run(now);
db.raw.prepare("INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES ('tok2','u2',?,'2099-01-01')").run(now);
db.raw.prepare("INSERT INTO sales (id,name,created_at,user_id) VALUES ('s1','Guestimator',?,'u1')").run(now);
db.raw.prepare("INSERT INTO sales (id,name,created_at,user_id) VALUES ('s2','Guestimator',?,'u2')").run(now);
const res = (name, low, high) => JSON.stringify({ identification: { name }, price_range: { low, high, suggested_retail: Math.round((low + high) / 2) }, confidence: 0.9, sold_market: { count: 3, low, median: Math.round((low + high) / 2), high, as_of: now }, comparables: [{ title: name + " sold one", price: low, source: "ebay.com (sold)", url: "https://www.ebay.com/itm/1" }] });
const item = (id, sale, name, est) => { db.raw.prepare("INSERT INTO items (id,sale_id,name,price_cents,status,created_at,description) VALUES (?,?,?,0,'available',?,?)").run(id, sale, name, now, "desc of " + name); if (est) db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at,completed_at) VALUES (?,?,'done',?,?,?)").run("a-" + id, id, res(name, est[0], est[1]), now, now); };
item("i1", "s1", "Kenmore sewing machine", [80, 120]); item("i2", "s1", "Oak dresser", [150, 250]); item("i3", "s1", "Box of books", null); item("theirs", "s2", "Not mine", [1, 2]);
const call = async (path, { method = "GET", body, who = "tok1" } = {}) => { const r = await worker.fetch(new Request("https://g.test" + path, { method, redirect: "manual", headers: { ...(body ? { "content-type": "application/json" } : {}), ...(who ? { cookie: "bt_session=" + who } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, text, json, loc: r.headers.get("location") }; };

// landing page
let r = await call("/inventory-report", { who: null });
ok("landing: public, indexable, says what it is not", r.status === 200 && !r.text.includes("noindex") && r.text.includes("not an appraisal") && r.text.includes("$49.00") && r.text.includes("$149.00") && r.text.includes("$299.00") && r.text.includes("/report/new"));
ok("landing: never calls it an appraisal service", !/our appraisers|certified appraisal service/i.test(r.text));
ok("sitemap lists it", P.sitemap([], "https://g.test").includes("https://g.test/inventory-report<"));
r = await call("/report/new", { who: null });
ok("new-report page serves without a session, noindex", r.status === 200 && r.text.includes("noindex") && r.text.includes("Create the report"));
r = await call("/api/reports", { method: "POST", body: { title: "12 Elm St", purpose: "estate", tier: "small", owner_name: "Estate of J. Doe" }, who: null });
ok("api: no session -> 401", r.status === 401);
r = await call("/api/reports", { method: "POST", body: { title: "12 Elm St", purpose: "estate", tier: "small", owner_name: "Estate of J. Doe" } });
ok("create: draft, small tier, cap 25, $49", r.status === 200 && r.json.status === "draft" && r.json.items_cap === 25 && r.json.price_cents === 4900 && r.json.heading === "Estate inventory" && r.json.items.length === 0, r.json);
const rid = r.json.id;
r = await call(`/api/reports/${rid}/items`, { method: "POST", body: { item_ids: ["i1", "i2", "i3", "theirs", "i1"] } });
ok("add items: mine added once each, someone else's ignored", r.json.added === 3 && r.json.over === 0, r.json);
r = await call(`/api/reports/${rid}`);
ok("get: items with estimates and the total of estimated ones", r.json.counts.items === 3 && r.json.counts.estimated === 2 && r.json.total.low === 230 && r.json.total.high === 370 && r.json.items[2].status === "none", r.json.counts);
ok("get: someone else can't see it", (await call(`/api/reports/${rid}`, { who: "tok2" })).status === 404);
r = await call(`/report/${rid}/print`);
ok("print: not paid -> back to the report page", r.status === 302 && r.loc === `https://g.test/report/${rid}`, r);
// cap
const big = await call("/api/reports", { method: "POST", body: { title: "cap test", purpose: "insurance", tier: "small" } });
for (let n = 0; n < 26; n++) item("c" + n, "s1", "thing " + n, null);
r = await call(`/api/reports/${big.json.id}/items`, { method: "POST", body: { item_ids: Array.from({ length: 26 }, (_, n) => "c" + n) } });
ok("cap: 25 fit, 1 over", r.json.added === 25 && r.json.over === 1 && r.json.cap === 25, r.json);
// checkout and finish
r = await call(`/api/reports/${rid}/checkout`, { method: "POST" });
ok("checkout: Stripe session opened for $49, report pending", r.status === 200 && r.json.url === "https://checkout.stripe.test/pay" && /unit_amount%5D=4900/.test(String(stripeCalls[0].body)) && /success_url=https%3A%2F%2Fg.test%2Freport%2F/.test(String(stripeCalls[0].body)), { s: r.status, body: String(stripeCalls[0] && stripeCalls[0].body).slice(0, 300) });
ok("checkout: product text says not a certified appraisal", /Not\+a\+certified\+appraisal|Not%20a%20certified%20appraisal/.test(String(stripeCalls[0].body)), String(stripeCalls[0].body).slice(0, 600));
r = await call(`/api/reports/${rid}/finish`, { method: "POST" });
ok("finish before paying: 402, nothing granted", r.status === 402 && db.raw.prepare("SELECT credits FROM users WHERE id='u1'").get().credits === 1, r.json);
paidState = "paid";
r = await call(`/api/reports/${rid}/finish`, { method: "POST" });
ok("finish after paying: paid, 25 credits granted once", r.status === 200 && r.json.credits === 25 && db.raw.prepare("SELECT credits FROM users WHERE id='u1'").get().credits === 26, r.json);
r = await call(`/api/reports/${rid}/finish`, { method: "POST" });
ok("finish again: already, no second grant", r.json.already === true && db.raw.prepare("SELECT credits FROM users WHERE id='u1'").get().credits === 26 && db.raw.prepare("SELECT COUNT(*) n FROM billing_events WHERE source='report'").get().n === 1);
r = await call(`/api/reports/${rid}`);
ok("report reads paid", r.json.status === "paid" && r.json.paid_at);
r = await call(`/report/${rid}/print`);
ok("print: paid -> the report, with heading, items, total, basis box, noindex", r.status === 200 && r.text.includes("Estate inventory: 12 Elm St") && r.text.includes("Prepared for Estate of J. Doe") && r.text.includes("Kenmore sewing machine") && r.text.includes("$230 – $370") && r.text.includes("not a certified or USPAP valuation") && r.text.includes("noindex") && r.text.includes("(1 not estimated, excluded)"));
ok("print: someone else is sent away", (await call(`/report/${rid}/print`, { who: "tok2" })).status === 404);
ok("print: no session -> report page", (await call(`/report/${rid}/print`, { who: null })).status === 302);
r = await call(`/api/reports/${rid}/items/i3`, { method: "DELETE" });
ok("remove item", r.status === 200 && (await call(`/api/reports/${rid}`)).json.counts.items === 2);
r = await call("/api/reports");
ok("list: both reports, newest first, with counts", r.json.length === 2 && r.json[0].title === "cap test" && r.json[0].item_count === 25);
// sweep: a pending report paid but never returned to
const late = await call("/api/reports", { method: "POST", body: { title: "late", purpose: "divorce", tier: "medium" } });
await call(`/api/reports/${late.json.id}/checkout`, { method: "POST" });
db.raw.prepare("UPDATE inventory_reports SET updated_at='2026-01-01T00:00:00Z' WHERE id=?").run(late.json.id);
const swept = await INV.sweep(env, db, (await import("../garage.js")).stripe);
ok("sweep: finishes the stale pending report and grants 100", swept === 1 && db.raw.prepare("SELECT status FROM inventory_reports WHERE id=?").get(late.json.id).status === "paid" && db.raw.prepare("SELECT credits FROM users WHERE id='u1'").get().credits === 126, swept);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

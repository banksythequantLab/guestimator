// Run:  node worker/tests/tax_test.mjs
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { taxSummary, taxPage } from "../tax.js";
const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 500) : ""}`)); };
globalThis.fetch = async () => new Response("{}", { status: 404 });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, ASSETS: { fetch: async () => new Response("a") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} }, PUBLIC_ORIGIN: "https://g.test" };
let cookie = "";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, redirect: "manual", headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const t = await r.text(); let json = null; try { json = JSON.parse(t); } catch {}
  return { status: r.status, json, text: t, location: r.headers.get("location") };
};
ok("signed out -> sign in", (await call("GET", "/tax-summary?year=2026")).status === 302);
await call("POST", "/api/auth/register", { email: "d@example.com", password: "password123" });
const me = db.raw.prepare("SELECT id FROM users WHERE email='d@example.com'").get().id;
const mk = async n => (await call("POST", "/api/items", { name: n, description: n })).json.id;
const a = await mk("RAM"), b = await mk("Lamp"), c = await mk("Old");
const t = "2026-06-01T12:00:00Z";
db.raw.prepare("INSERT INTO ebay_orders (id,user_id,order_id,line_item_id,item_id,status,total_cents,ship_paid_cents,fee_cents,ordered_at,created_at,updated_at) VALUES (?,?,?,?,?,'FULFILLED',?,?,?,?,?,?)")
  .run("e1", me, "12-1", "L1", a, 6800, 800, 790, t, t, t);
await call("PUT", `/api/items/${a}/cost`, { cost: "20" });
await call("POST", `/api/items/${b}/sold`, { price: "15" });
db.raw.prepare("UPDATE item_finance SET sold_at=? WHERE item_id=?").run("2026-07-04T15:00:00Z", b);
db.raw.prepare("INSERT INTO ebay_orders (id,user_id,order_id,line_item_id,item_id,status,total_cents,ordered_at,created_at,updated_at) VALUES (?,?,?,?,?,'FULFILLED',?,?,?,?)")
  .run("e2", me, "12-2", "L2", c, 5000, "2025-12-31T10:00:00Z", t, t);
const s = await taxSummary(db, me, 2026);
const eb = s.channels.find(x => x.channel === "eBay"), ip = s.channels.find(x => x.channel === "In person");
ok("eBay: gross = item + shipping paid; fees; cost", eb && eb.sales === 1 && eb.gross_cents === 6800 && eb.fee_cents === 790 && eb.cost_cents === 2000 && eb.net_cents === 4010, eb);
ok("in person counted", ip && ip.gross_cents === 1500 && ip.missing_cost === 1, ip);
ok("last year's sale not in this year", s.totals.sales === 2, s.totals);
ok("2025 has the old one", (await taxSummary(db, me, 2025)).totals.gross_cents === 5000);
const r = await call("GET", "/tax-summary?year=2026");
ok("page: totals, CSV link, missing-cost warning, not-advice note", r.status === 200 && r.text.includes("$83.00") && r.text.includes("/api/profit/csv?from=") && /has no cost entered/.test(r.text) && /not tax advice/.test(r.text), r.text.slice(0, 200));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
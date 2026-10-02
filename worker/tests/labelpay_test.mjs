// Run:  node worker/tests/labelpay_test.mjs
// Pay-then-ship labels through the REAL worker routes, with Shippo and Stripe stubbed at fetch().
// Proves: the seller is charged before anything is bought, the charge covers Stripe's fee, a
// label is bought once per payment, failures refund, and the monthly house cap stops new checkouts.
// NOT proven: a real Stripe payment or a real Shippo label (needs one live purchase).
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as P from "../labelpay.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

// ---------- pure ----------
const p = P.priceLabel(745);
ok("price covers Stripe 2.9% + 30c", p.total === 799 && p.processing === 54 && p.total - Math.round(p.total * 0.029) - 30 >= 745, p);
const pf = P.priceLabel(745, 50);
ok("optional fee on top", pf.fee === 50 && pf.total - Math.round(pf.total * 0.029) - 30 >= 795, pf);
ok("cap default 30, override", P.houseCap({}) === 30 && P.houseCap({ SHIPPO_MONTHLY_CAP: "500" }) === 500);
ok("off unless LABEL_PAY=on with both keys", !P.payOn({ STRIPE_SECRET_KEY: "s", SHIPPO_API_TOKEN: "t" }) && P.payOn({ LABEL_PAY: "on", STRIPE_SECRET_KEY: "s", SHIPPO_API_TOKEN: "t" }) && !P.payOn({ LABEL_PAY: "on", SHIPPO_API_TOKEN: "t" }));
ok("month start", P.monthStart(Date.parse("2026-10-17T05:00:00Z")) === "2026-10-01T00:00:00.000Z");

// ---------- stubs ----------
const calls = [];
const RATE = "a".repeat(32);
let rateAmount = "7.45", payStatus = "unpaid", sessStatus = "open", txFail = false, sess = 0;
const jr = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (u, init = {}) => {
  const url = String(u), method = init.method || "GET";
  const body = typeof init.body === "string" ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })() : init.body || null;
  calls.push({ url, method, body, headers: init.headers || {} });
  if (url === "https://api.goshippo.com/shipments/") return jr({ rates: [
    { object_id: RATE, provider: "USPS", servicelevel: { token: "usps_ground_advantage", name: "Ground Advantage" }, amount: "7.45", currency: "USD", estimated_days: 4 }] });
  if (url.startsWith("https://api.goshippo.com/rates/")) return jr({ object_id: RATE, provider: "USPS", servicelevel: { name: "Ground Advantage" }, amount: rateAmount });
  if (url === "https://api.goshippo.com/transactions/") return jr(txFail ? { status: "ERROR", messages: [{ text: "Address not deliverable" }] }
    : { object_id: "tx" + calls.length, status: "SUCCESS", tracking_number: "9400111899223456789012", label_url: "https://deliver.goshippo.com/x.pdf" });
  if (url === "https://api.stripe.com/v1/checkout/sessions" && method === "POST") return jr({ id: "cs_" + (++sess), url: "https://checkout.stripe.test/pay" });
  if (url.startsWith("https://api.stripe.com/v1/checkout/sessions/")) return jr({ id: url.split("/").pop(), payment_status: payStatus, status: sessStatus, payment_intent: "pi_" + url.split("_").pop() });
  if (url === "https://api.stripe.com/v1/refunds") return jr({ id: "re_1", status: "succeeded" });
  return jr({ error: "unstubbed " + url }, 404);
};

const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const pending = [];
const env = {
  DB: db, ASSETS: { fetch: async () => new Response("asset") },
  PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", SHIPPO_API_TOKEN: "shippo_test_x", LABEL_USERS: "d@example.com",
  STRIPE_SECRET_KEY: "sk_test_x", LABEL_PAY: "on",
  EMAIL: { send: async () => ({ messageId: "m" }) },
};
const jar = { d: "", x: "", y: "" }; let who = "x";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie: jar[who] },
    body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil(p) { pending.push(p); } });
  const sc = r.headers.get("set-cookie"); if (sc) jar[who] = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json };
};
const settle = async () => { while (pending.length) await pending.shift(); };
for (const w of ["d", "y", "x"]) { who = w; await call("POST", "/api/auth/register", { email: `${w}@example.com`, password: "password123" }); }
const xid = db.raw.prepare("SELECT id FROM users WHERE email='x@example.com'").get().id;
const item = (await call("POST", "/api/items", { name: "RAM", description: "32gb" })).json.id;
db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)").run(crypto.randomUUID(), item,
  JSON.stringify({ shipping: { box_in: [10, 5, 5], packed_weight_lb: 0.4 } }), new Date().toISOString());
const saleId = crypto.randomUUID(), t0 = new Date().toISOString();
db.raw.prepare("INSERT INTO garage_sales (id,user_id,slug,title,kind,city,state,starts_on,ends_on,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(saleId, xid, "elm-st-1", "Elm St", "garage", "Montclair", "NJ", "2026-10-10", "2026-10-10", "published", t0, t0);
const addr = JSON.stringify({ name: "Rae Buyer", address: { line1: "5 Oak St", city: "Austin", state: "TX", postal_code: "78701", country: "US" } });
const order = id => db.raw.prepare("INSERT INTO garage_orders (id,sale_id,item_id,seller_account,fulfilment,item_cents,ship_cents,fee_cents,total_cents,buyer_email,ship_address,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(id, saleId, item, "acct_S", "ship", 5000, 800, 174, 5800, "rae@example.com", addr, "paid", t0, t0);
["o1", "o2", "o3", "o4", "o5"].forEach(order);
const txCount = () => calls.filter(c => c.url.endsWith("/transactions/")).length;
const payRow = id => db.raw.prepare("SELECT * FROM label_payments WHERE id=?").get(id);

// ---------- routes ----------
let r = await call("GET", "/api/labels/settings");
ok("any seller: on, paid by card", r.json.enabled === true && r.json.payer === "paid" && r.json.house_month === null, r.json);
who = "d"; r = await call("GET", "/api/labels/settings");
ok("house account sees the monthly count", r.json.payer === "house" && r.json.house_month.used === 0 && r.json.house_month.cap === 30, r.json); who = "x";
await call("PUT", "/api/labels/settings", { name: "Xavier", street1: "1 Main St", city: "Kenilworth", state: "NJ", zip: "07033" });
r = await call("POST", "/api/labels/rates", { kind: "garage", order_id: "o1" });
ok("rates show what the card is charged", r.status === 200 && r.json.rates[0].pay.total === 799 && r.json.rates[0].pay.label === 745, r.json);
ok("direct buy refused: pay first", (await call("POST", "/api/labels/buy", { kind: "garage", order_id: "o1", rate_id: RATE, amount_cents: 745 })).status === 402 && txCount() === 0);
rateAmount = "8.10";
ok("price moved -> no checkout", (await call("POST", "/api/labels/pay", { kind: "garage", order_id: "o1", rate_id: RATE, amount_cents: 745 })).status === 409); rateAmount = "7.45";
r = await call("POST", "/api/labels/pay", { kind: "garage", order_id: "o1", rate_id: RATE, amount_cents: 745, file_type: "PDF" });
const cs = calls.filter(c => c.url === "https://api.stripe.com/v1/checkout/sessions").pop();
ok("checkout opened on the platform account for label + processing", r.status === 200 && r.json.url.startsWith("https://checkout.stripe.test") &&
   cs.body.get("line_items[0][price_data][unit_amount]") === "799" && !cs.headers["stripe-account"] && cs.body.get("success_url") === `https://g.test/?labelpaid=${r.json.id}`, r.json);
const pay1 = r.json.id;
ok("payment row pending, nothing bought yet", payRow(pay1).status === "pending" && payRow(pay1).total_cents === 799 && txCount() === 0);
ok("not paid yet -> nothing bought", (await call("POST", "/api/labels/paid", { id: pay1 })).status === 402 && txCount() === 0);
who = "y"; ok("someone else can't finish it", (await call("POST", "/api/labels/paid", { id: pay1 })).status === 404 && txCount() === 0); who = "x";
payStatus = "paid";
r = await call("POST", "/api/labels/paid", { id: pay1 }); await settle();
ok("paid -> label bought on the house account", r.status === 200 && r.json.label.label_url.endsWith(".pdf") && txCount() === 1 &&
   calls.filter(c => c.url.endsWith("/transactions/")).pop().headers.authorization === "ShippoToken shippo_test_x", r.json);
ok("payment marked bought, label counted as paid", payRow(pay1).status === "bought" && db.raw.prepare("SELECT payer FROM shipping_labels WHERE id=?").get(payRow(pay1).label_id).payer === "paid");
ok("order marked shipped", db.raw.prepare("SELECT status FROM garage_orders WHERE id='o1'").get().status === "fulfilled");
r = await call("POST", "/api/labels/paid", { id: pay1 });
ok("coming back twice buys nothing more", r.status === 200 && r.json.already && txCount() === 1);
ok("no second checkout for a labelled order", (await call("POST", "/api/labels/pay", { kind: "garage", order_id: "o1", rate_id: RATE, amount_cents: 745 })).status === 409);

// price moved between paying and buying -> refund, nothing bought
payStatus = "unpaid";
const pay2 = (await call("POST", "/api/labels/pay", { kind: "garage", order_id: "o2", rate_id: RATE, amount_cents: 745 })).json.id;
payStatus = "paid"; rateAmount = "9.00";
r = await call("POST", "/api/labels/paid", { id: pay2 }); rateAmount = "7.45";
ok("rate gone stale -> refunded, no label", r.status === 502 && r.json.refunded && payRow(pay2).status === "refunded" && txCount() === 1 &&
   calls.some(c => c.url.endsWith("/v1/refunds") && c.body.get("payment_intent") === payRow(pay2).payment_intent), r.json);

// Shippo refuses the label -> refund
payStatus = "unpaid";
const pay3 = (await call("POST", "/api/labels/pay", { kind: "garage", order_id: "o3", rate_id: RATE, amount_cents: 745 })).json.id;
payStatus = "paid"; txFail = true;
r = await call("POST", "/api/labels/paid", { id: pay3 }); txFail = false;
// (the refused attempt is one Shippo call; no label row is saved)
ok("Shippo error -> refunded", r.status === 502 && r.json.refunded && /not deliverable/.test(r.json.error) && payRow(pay3).status === "refunded", r.json);

// tab closed after paying: opening the order finishes it
payStatus = "unpaid";
const pay4 = (await call("POST", "/api/labels/pay", { kind: "garage", order_id: "o4", rate_id: RATE, amount_cents: 745 })).json.id;
payStatus = "paid";
r = await call("GET", "/api/labels/for?kind=garage&order=o4"); await settle();
ok("order screen finishes a paid checkout", r.json.label && payRow(pay4).status === "bought" && txCount() === 3, r.json);

// sweep (cron) finishes old paid checkouts too
payStatus = "unpaid";
const pay5 = (await call("POST", "/api/labels/pay", { kind: "garage", order_id: "o5", rate_id: RATE, amount_cents: 745 })).json.id;
payStatus = "paid";
db.raw.prepare("UPDATE label_payments SET created_at=? WHERE id=?").run(new Date(Date.now() - 20 * 60e3).toISOString(), pay5);
const labelsMod = await import("../labels.js");
const garageMod = await import("../garage.js");
const swept = await P.sweep(env, db, garageMod.stripe, uid => row => labelsMod.buyLabel(env, db, uid, row.kind, row.order_id, row.rate_id, row.label_cents, row.file_type, "https://g.test", null, null));
ok("sweep buys paid-but-abandoned", swept.length === 1 && swept[0].status === 200 && payRow(pay5).status === "bought" && txCount() === 4, swept);

// monthly cap: 3 house labels used; cap 3 stops new checkouts
who = "d"; r = await call("GET", "/api/labels/settings");
ok("house count includes card-paid labels", r.json.house_month.used === 3, r.json.house_month); who = "x";
env.SHIPPO_MONTHLY_CAP = "3"; order("o6");
r = await call("POST", "/api/labels/pay", { kind: "garage", order_id: "o6", rate_id: RATE, amount_cents: 745 });
ok("at the cap: no checkout opened", r.status === 503 && r.json.cap, r.json);
delete env.SHIPPO_MONTHLY_CAP;
env.LABEL_PAY = "off";
ok("switched off -> back to 403", (await call("POST", "/api/labels/rates", { kind: "garage", order_id: "o6" })).status === 403);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

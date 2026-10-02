// Run:  node worker/tests/shipops_test.mjs
// Void, USPS pickup, ship-by reminders and money-safety alerts, through the REAL worker routes and
// cron functions, with Shippo / Stripe / email stubbed. NOT proven: a real Shippo void or pickup.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as S from "../shipops.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

// ---------- pure ----------
const days = S.pickupDays(Date.parse("2026-10-03T15:00:00Z"));   // a Saturday
ok("pickup days skip Sunday", days.join() === "2026-10-05,2026-10-06,2026-10-07", days);
ok("canVoid: fresh yes, old or voided no", S.canVoid({ created_at: new Date().toISOString() }) && !S.canVoid({ created_at: "2026-01-01T00:00:00Z" }) && !S.canVoid({ created_at: new Date().toISOString(), void_of: "x" }));
ok("admin email falls back to first LABEL_USERS", S.adminEmail({ LABEL_USERS: "a@x.com,b@x.com" }) === "a@x.com" && S.adminEmail({ ADMIN_EMAIL: "z@x.com", LABEL_USERS: "a@x.com" }) === "z@x.com");

// ---------- stubs ----------
const calls = [], mails = [];
const RATE = "a".repeat(32);
let payStatus = "unpaid", refundPost = "QUEUED", refundGet = "QUEUED", pickupStatus = "CONFIRMED", sess = 0, tx = 0;
const jr = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (u, init = {}) => {
  const url = String(u), method = init.method || "GET";
  const body = typeof init.body === "string" ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })() : init.body || null;
  calls.push({ url, method, body });
  if (url === "https://api.goshippo.com/shipments/") return jr({ rates: [{ object_id: RATE, provider: "USPS", servicelevel: { token: "usps_ground_advantage", name: "Ground Advantage" }, amount: "7.45", currency: "USD" }] });
  if (url.startsWith("https://api.goshippo.com/rates/")) return jr({ object_id: RATE, provider: "USPS", servicelevel: { name: "Ground Advantage" }, amount: "7.45", carrier_account: "ca_usps" });
  if (url === "https://api.goshippo.com/transactions/") return jr({ object_id: "tx" + (++tx), status: "SUCCESS", tracking_number: "94001118992234567890" + tx, label_url: "https://deliver.goshippo.com/x.pdf" });
  if (url === "https://api.goshippo.com/refunds/") return jr(refundPost === "ERROR" ? { status: "ERROR", messages: [{ text: "Label already scanned" }] } : { object_id: "rf" + calls.length, status: refundPost, transaction: body.transaction });
  if (url.startsWith("https://api.goshippo.com/refunds/")) return jr({ object_id: url.split("/").pop(), status: refundGet });
  if (url === "https://api.goshippo.com/pickups/") return jr(pickupStatus === "ERROR" ? { status: "ERROR", messages: [{ text: "Address not eligible" }] }
    : { object_id: "pk1", status: pickupStatus, confirmation_code: "WTC123", confirmed_start_time: body.requested_start_time, confirmed_end_time: body.requested_end_time, timezone: "US/Eastern" });
  if (url === "https://api.stripe.com/v1/checkout/sessions" && method === "POST") return jr({ id: "cs_" + (++sess), url: "https://checkout.stripe.test/pay" });
  if (url.startsWith("https://api.stripe.com/v1/checkout/sessions/")) return jr({ id: url.split("/").pop(), payment_status: payStatus, status: "open", payment_intent: "pi_" + url.split("_").pop() });
  if (url === "https://api.stripe.com/v1/refunds") return jr({ id: "re_" + calls.length, status: "succeeded" });
  return jr({ error: "unstubbed " + url }, 404);
};

const { default: worker } = await import("../worker.js");
const garageMod = await import("../garage.js");
const db = d1(join(here, "..", "migrations"));
const pending = [];
const env = {
  DB: db, ASSETS: { fetch: async () => new Response("asset") },
  PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", SHIPPO_API_TOKEN: "shippo_test_x", LABEL_USERS: "d@example.com",
  STRIPE_SECRET_KEY: "sk_test_x", LABEL_PAY: "on",
  EMAIL: { send: async m => { mails.push(m); return { messageId: "m" }; } },
};
const jar = { d: "", x: "" }; let who = "x";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, headers: { "content-type": "application/json", cookie: jar[who] },
    body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil(p) { pending.push(p); } });
  const sc = r.headers.get("set-cookie"); if (sc) jar[who] = sc.split(";")[0];
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json };
};
const settle = async () => { while (pending.length) await pending.shift(); };
for (const w of ["d", "x"]) { who = w; await call("POST", "/api/auth/register", { email: `${w}@example.com`, password: "password123" }); }
const uid = w => db.raw.prepare("SELECT id FROM users WHERE email=?").get(`${w}@example.com`).id;
const t0 = new Date().toISOString();
const addr = JSON.stringify({ name: "Rae Buyer", address: { line1: "5 Oak St", city: "Austin", state: "TX", postal_code: "78701", country: "US" } });
async function setup(w) {
  who = w;
  const item = (await call("POST", "/api/items", { name: "RAM " + w, description: "32gb" })).json.id;
  db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?,'done',?,?)").run(crypto.randomUUID(), item, JSON.stringify({ shipping: { box_in: [10, 5, 5], packed_weight_lb: 0.4 } }), t0);
  const sale = crypto.randomUUID();
  db.raw.prepare("INSERT INTO garage_sales (id,user_id,slug,title,kind,city,state,starts_on,ends_on,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(sale, uid(w), "sale-" + w, "Elm St " + w, "garage", "Montclair", "NJ", "2026-10-10", "2026-10-10", "published", t0, t0);
  await call("PUT", "/api/labels/settings", { name: "Seller " + w, street1: "1 Main St", city: "Kenilworth", state: "NJ", zip: "07033" });
  return { item, sale };
}
const order = (s, id, created = t0) => db.raw.prepare("INSERT INTO garage_orders (id,sale_id,item_id,seller_account,fulfilment,item_cents,ship_cents,fee_cents,total_cents,buyer_email,ship_address,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(id, s.sale, s.item, "acct_S", "ship", 5000, 800, 174, 5800, "rae@example.com", addr, "paid", created, created);
const X = await setup("x"), D = await setup("d");
order(X, "x1"); order(D, "d1");

// x buys a card-paid label for x1
who = "x";
let r = await call("POST", "/api/labels/pay", { kind: "garage", order_id: "x1", rate_id: RATE, amount_cents: 745 });
const pay1 = r.json.id; payStatus = "paid";
r = await call("POST", "/api/labels/paid", { id: pay1 }); await settle();
ok("setup: paid label bought", r.status === 200 && r.json.label, r.json);
r = await call("GET", "/api/labels/for?kind=garage&order=x1");
ok("label shows void + pickup options", r.json.label.can_void === true && r.json.label.payer === "paid" && r.json.label.pickup === null, r.json);

// ---------- pickup ----------
const d0 = (await call("GET", "/api/labels/pickup-days")).json;
ok("pickup days + locations offered", d0.days.length === 3 && d0.locations.includes("Front Door"));
const pk = b => call("POST", "/api/labels/pickup", { kind: "garage", order_id: "x1", date: d0.days[0], location: "Front Door", phone: "(908) 555-0100", ...b });
ok("pickup: day not offered", (await pk({ date: "2020-01-01" })).status === 400);
ok("pickup: Other needs a note", (await pk({ location: "Other" })).status === 400);
ok("pickup: needs a phone", (await pk({ phone: "" })).json.needs_phone === true);
ok("nothing sent to Shippo yet", !calls.some(c => c.url.endsWith("/pickups/")));
pickupStatus = "ERROR";
r = await pk({});
ok("USPS refusal reported, nothing saved", r.status === 409 && /not eligible/.test(r.json.error) && !db.raw.prepare("SELECT pickup FROM shipping_labels WHERE order_id='x1'").get().pickup, r.json);
pickupStatus = "CONFIRMED";
r = await pk({ instructions: "Blue bin by the steps" });
const pc = calls.filter(c => c.url.endsWith("/pickups/")).pop().body;
ok("pickup booked with the label's USPS account and the seller's address", r.status === 200 && r.json.pickup.confirmation === "WTC123" &&
   pc.carrier_account === "ca_usps" && pc.transactions[0] === "tx1" && pc.location.address.phone === "9085550100" && pc.location.address.email === "x@example.com" &&
   pc.location.address.street1 === "1 Main St" && pc.requested_start_time === `${d0.days[0]}T13:00:00Z` && pc.location.instructions === "Blue bin by the steps", { r: r.json, pc });
ok("second pickup refused", (await pk({})).status === 409);
ok("pickup shows on the label", (await call("GET", "/api/labels/for?kind=garage&order=x1")).json.label.pickup.confirmation === "WTC123");

// ---------- void (card-paid) ----------
const stripeRefunds = () => calls.filter(c => c.url === "https://api.stripe.com/v1/refunds");
r = await call("POST", "/api/labels/void", { kind: "garage", order_id: "x1" });
ok("void accepted (queued at Shippo)", r.status === 200 && r.json.void_status === "QUEUED" && r.json.reopened === true && /once Shippo confirms/.test(r.json.note), r.json);
ok("Shippo asked to refund that transaction", calls.filter(c => c.url === "https://api.goshippo.com/refunds/").pop().body.transaction === "tx1");
ok("card NOT refunded before Shippo confirms", stripeRefunds().length === 0);
const go = db.raw.prepare("SELECT status, tracking FROM garage_orders WHERE id='x1'").get();
ok("garage order reopened", go.status === "paid" && go.tracking === null, go);
r = await call("GET", "/api/labels/for?kind=garage&order=x1");
ok("order has no live label; the voided one is listed", r.json.label === null && r.json.voided.void_status === "QUEUED", r.json);
ok("can't void twice", (await call("POST", "/api/labels/void", { kind: "garage", order_id: "x1" })).status === 404);
const envFor = l => l.payer === "seller" ? null : env;
refundGet = "PENDING";
await S.checkVoids(env, db, envFor, garageMod.stripe);
ok("still pending: no card refund", stripeRefunds().length === 0 && db.raw.prepare("SELECT void_status FROM shipping_labels WHERE void_of='x1'").get().void_status === "PENDING");
refundGet = "SUCCESS";
await S.checkVoids(env, db, envFor, garageMod.stripe);
const rf = stripeRefunds();
ok("Shippo refunded -> card refunded for label + fee, not processing", rf.length === 1 && rf[0].body.get("amount") === "745" && rf[0].body.get("payment_intent") === "pi_1", rf.map(x => x.body.toString()));
ok("payment marked voided", db.raw.prepare("SELECT status FROM label_payments WHERE id=?").get(pay1).status === "voided");
await S.checkVoids(env, db, envFor, garageMod.stripe);
ok("no double card refund", stripeRefunds().length === 1);
payStatus = "unpaid";
r = await call("POST", "/api/labels/pay", { kind: "garage", order_id: "x1", rate_id: RATE, amount_cents: 745 });
ok("a new label can be bought after voiding", r.status === 200, r.json);

// ---------- void (house label): refusal, age, refused later ----------
who = "d";
await call("POST", "/api/labels/buy", { kind: "garage", order_id: "d1", rate_id: RATE, amount_cents: 745 }); await settle();
refundPost = "ERROR";
r = await call("POST", "/api/labels/void", { kind: "garage", order_id: "d1" });
ok("Shippo refuses -> nothing changes", r.status === 409 && /already scanned/.test(r.json.error) && db.raw.prepare("SELECT status FROM garage_orders WHERE id='d1'").get().status === "fulfilled", r.json);
refundPost = "QUEUED";
db.raw.prepare("UPDATE shipping_labels SET created_at=? WHERE order_id='d1'").run(new Date(Date.now() - 40 * 86400e3).toISOString());
ok("too old to void", (await call("POST", "/api/labels/void", { kind: "garage", order_id: "d1" })).status === 409);
db.raw.prepare("UPDATE shipping_labels SET created_at=? WHERE order_id='d1'").run(t0);
r = await call("POST", "/api/labels/void", { kind: "garage", order_id: "d1" });
ok("house label voided, no card involved", r.status === 200 && r.json.note === null, r.json);
refundGet = "ERROR"; mails.length = 0;
await S.checkVoids(env, db, envFor, garageMod.stripe);
await S.checkVoids(env, db, envFor, garageMod.stripe);
ok("refused void -> house alerted once", mails.filter(m => /refused a label void/.test(m.subject)).length === 1 && mails[0].to === "d@example.com", mails.map(m => m.subject));

// ---------- ship-by reminders ----------
const now = Date.now(), iso = ms => new Date(ms).toISOString();
const ebayOrder = (id, shipBy, status = "NOT_STARTED", created = iso(now - 2 * 86400e3)) => db.raw.prepare("INSERT INTO ebay_orders (id,order_id,line_item_id,user_id,item_id,title,status,ship_by,ordered_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
  .run(id, id.split(":")[0], "1", uid("x"), X.item, "Optane", status, shipBy, created, created, created);
ebayOrder("E1:1", iso(now + 10 * 3600e3));          // due tomorrow
ebayOrder("E2:1", iso(now - 2 * 3600e3));           // overdue
ebayOrder("E3:1", iso(now + 5 * 86400e3));          // not yet
ebayOrder("E4:1", iso(now + 3600e3), "FULFILLED");  // shipped
ebayOrder("E5:1", iso(now + 3600e3), "NOT_STARTED", iso(now - 3600e3));  // just sold: the sale email covers it
order(X, "x2", iso(now - 3 * 86400e3));             // paid 3 days ago, unshipped
order(X, "x3", iso(now - 3600e3));                  // paid an hour ago
mails.length = 0;
let sent = await S.shipReminders(env, db, "https://g.test", now);
ok("reminds due + overdue eBay and the stale garage order only", sent.map(s => s.id).sort().join() === "E1:1,E2:1,x2", sent);
ok("overdue says so; links to the orders", mails.some(m => /^Overdue/.test(m.subject) && m.text.includes("https://g.test/#ebay-orders")) && mails.some(m => /^Ship by/.test(m.subject)) && mails.every(m => m.to === "x@example.com"), mails.map(m => m.subject));
sent = await S.shipReminders(env, db, "https://g.test", now + 3600e3);
ok("never twice", sent.length === 0);

// ---------- money-safety alerts ----------
mails.length = 0;
db.raw.prepare("INSERT INTO label_payments (id,user_id,kind,order_id,rate_id,label_cents,fee_cents,processing_cents,total_cents,session_id,payment_intent,status,created_at,updated_at) VALUES ('lp_b',?,?,?,?,745,0,54,799,'cs_b','pi_b','buying',?,?)")
  .run(uid("x"), "garage", "x2", RATE, iso(now - 30 * 60e3), iso(now - 30 * 60e3));
let a = await S.moneyAlerts(env, db, now);
ok("interrupted buy -> stuck, house told", a.stuck === 1 && db.raw.prepare("SELECT status FROM label_payments WHERE id='lp_b'").get().status === "stuck" &&
   mails.some(m => m.to === "d@example.com" && /need a look/.test(m.subject) && m.text.includes("pi_b")), mails.map(m => m.subject));
a = await S.moneyAlerts(env, db, now);
ok("stuck alert sent once", a.stuck === 0 && mails.filter(m => /need a look/.test(m.subject)).length === 1);
const used = (await import("../labelpay.js")).monthCount;
const n = await used(db, now);
env.SHIPPO_MONTHLY_CAP = String(n + 3); mails.length = 0;
a = await S.moneyAlerts(env, db, now);
ok("near the cap -> warned", a.cap === "warn" && mails.some(m => new RegExp(`${n} of ${n + 3}`).test(m.subject)), { a, n, s: mails.map(m => m.subject) });
ok("warning once a month", (await S.moneyAlerts(env, db, now)).cap === null);
env.SHIPPO_MONTHLY_CAP = String(n);
a = await S.moneyAlerts(env, db, now);
ok("cap reached -> told it's full", a.cap === "full" && mails.some(m => /cap reached/.test(m.subject)));
delete env.SHIPPO_MONTHLY_CAP;

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

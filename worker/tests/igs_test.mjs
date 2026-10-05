// Run:  node worker/tests/igs_test.mjs
// Instant Garage Sale: its own front page on its own host, quick-add items into a sale, and the
// sale's items exported as CSV and Excel.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import * as X from "../export.js";
import * as S from "../site.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 600) : ""}`)); };

// ---- site ----
const envH = { IGS_HOSTS: "instantgaragesale.com, www.instantgaragesale.com", PUBLIC_ORIGIN: "https://app.theguestimator.com" };
ok("IGS host recognised", S.isIgs(envH, new URL("https://www.instantgaragesale.com/x")) && !S.isIgs(envH, new URL("https://app.theguestimator.com/")));
ok("no IGS_HOSTS -> never IGS", !S.isIgs({}, new URL("https://instantgaragesale.com/")));
ok("links stay on the site in use", S.siteOrigin(envH, new URL("https://instantgaragesale.com/api")) === "https://instantgaragesale.com" &&
   S.siteOrigin(envH, new URL("https://guestimator.dj-b02.workers.dev/api")) === "https://app.theguestimator.com");

// ---- CSV ----
const rows = [
  { name: "Kids' bike, 20\"", description: "Blue\nbarely used", price_cents: 1500, online_price_cents: null, ship_cents: null, status: "available", sold_at: null, guess_low_cents: 1200, guess_high_cents: 2500, item_url: "https://x/sale/s/item/1", photo_url: "" },
  { name: "=HYPERLINK(\"http://evil\")", description: "Crème brûlée dish ½ off", price_cents: 250, status: "sold", sold_at: "2026-10-10T15:02:00Z", item_url: "u", photo_url: "p" },
];
const csv = X.toCsv(rows);
const lines = csv.slice(1).split("\r\n");
ok("CSV starts with the UTF-8 BOM", csv.charCodeAt(0) === 0xFEFF);
ok("CSV header", lines[0] === "Item,Description,Tag price,Online price,Shipping,Status,Sold on,Guestimate low,Guestimate high,Item page,Photo", lines[0]);
ok("quotes, commas and newlines quoted", csv.includes('"Kids\' bike, 20"""') && csv.includes('"Blue\nbarely used"'));
ok("money as dollars", lines[1].includes(",15.00,") && lines[1].includes(",12.00,25.00,"), lines[1]);
ok("formula defused", csv.includes(`"'=HYPERLINK(""http://evil"")"`), csv);
ok("sold date trimmed to the day", csv.includes(",sold,2026-10-10,"));
ok("accents survive", csv.includes("Crème brûlée dish ½ off"));

// ---- XLSX: a real ZIP whose stored parts are the workbook ----
function unzip(buf) {
  const out = {}, dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  while (dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true), size = dv.getUint32(p + 18, true), nlen = dv.getUint16(p + 26, true), xlen = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(buf.slice(p + 30, p + 30 + nlen));
    const data = buf.slice(p + 30 + nlen + xlen, p + 30 + nlen + xlen + size);
    out[name] = { method, crc: dv.getUint32(p + 14, true), text: new TextDecoder().decode(method ? inflateRawSync(data) : data), data };
    p += 30 + nlen + xlen + size;
  }
  return { files: out, centralAt: p, endOk: dv.getUint32(buf.length - 22, true) === 0x06054b50 && dv.getUint16(buf.length - 12, true) === Object.keys(out).length };
}
const xl = X.toXlsx(rows, { sheet: "Big Sat: sale/2026" });
const z = unzip(xl);
ok("xlsx: six parts + valid end record", Object.keys(z.files).length === 6 && z.endOk, Object.keys(z.files));
ok("xlsx: content types, workbook, sheet present", ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/styles.xml"].every(n => z.files[n]));
const sh = z.files["xl/worksheets/sheet1.xml"].text;
ok("xlsx: header bold, frozen row, filter", sh.includes('<c r="A1" t="inlineStr" s="1"><is><t>Item</t>') && sh.includes('state="frozen"') && sh.includes('<autoFilter ref="A1:K3"/>'));
ok("xlsx: prices are numbers in $ format", sh.includes('<c r="C2" s="2"><v>15</v></c>') && sh.includes('<c r="H2" s="2"><v>12</v></c>'), sh.slice(0, 900));
ok("xlsx: text escaped, stored as text (no formula)", sh.includes("Kids' bike, 20&quot;") && sh.includes(">=HYPERLINK(&quot;http://evil&quot;)</t>") && !sh.includes("<f>"));
ok("xlsx: sheet name cleaned", z.files["xl/workbook.xml"].text.includes('name="Big Sat  sale 2026"'), z.files["xl/workbook.xml"].text);
{ // CRC of every part matches its bytes
  let crcOk = true;
  for (const f of Object.values(z.files)) { let c = 0xFFFFFFFF; for (const b of f.data) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; } if (((c ^ 0xFFFFFFFF) >>> 0) !== f.crc) crcOk = false; }
  ok("xlsx: CRC-32 of each part is right", crcOk);
}
ok("file name", X.exportName({ title: "Big Saturday Sale!", starts_on: "2026-10-10" }, "xlsx") === "big-saturday-sale-2026-10-10-items.xlsx");

// ---- through worker.js ----
globalThis.fetch = async u => new Response(JSON.stringify({ error: "unstubbed " + u }), { status: 404 });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const assetHits = [], mails = [];
const env = { DB: db, PUBLIC_ORIGIN: "https://app.theguestimator.com", IGS_HOSTS: "instantgaragesale.com",
  ASSETS: { fetch: async req => { assetHits.push(new URL(req.url).pathname); return new Response("<html>asset " + new URL(req.url).pathname + "</html>", { headers: { "content-type": "text/html" } }); } },
  PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  EMAIL: { send: async m => { mails.push(m); return { messageId: "m" }; } } };
let cookie = "";
const call = async (method, path, body, host = "https://instantgaragesale.com") => {
  const isForm = body instanceof FormData;
  const r = await worker.fetch(new Request(host + path, { method, redirect: "manual", headers: isForm ? { cookie } : { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const buf = new Uint8Array(await r.arrayBuffer()), t = new TextDecoder().decode(buf); let json = null; try { json = JSON.parse(t); } catch {}
  return { status: r.status, json, text: t, buf, headers: r.headers };
};

let r = await call("GET", "/");
ok("IGS host: / is the Instant Garage Sale page", r.status === 200 && assetHits.at(-1) === "/igs/" && r.text.includes("asset /igs/"), assetHits);
r = await call("GET", "/manifest.webmanifest");
ok("IGS host: its own manifest", assetHits.at(-1) === "/igs/manifest.webmanifest");
r = await call("GET", "/", undefined, "https://app.theguestimator.com");
ok("Guestimator host: / unchanged", assetHits.at(-1) === "/");

r = await call("POST", "/api/auth/register", { email: "yard@example.com", password: "password123" });
ok("sign up on IGS works, no Guestimator welcome email", r.status === 200 && !mails.some(m => /Welcome/.test(m.subject || "")), mails.map(m => m.subject));

// Sale first...
r = await call("POST", "/api/garage/sales", { title: "Big Saturday Sale", kind: "yard", city: "Montclair", state: "nj", starts_on: "2026-10-10", ends_on: "2026-10-10", pickup_ok: true });
const sid = r.json.id;
ok("sale created first", r.status === 200 && !!sid, r.json);
r = await call("PATCH", `/api/garage/sales/${sid}`, { status: "published" });
ok("can't publish an empty sale", r.status === 409);
// ...then quick-add items: item, photo, into the sale with a typed price.
const quick = async (name, price) => {
  const id = (await call("POST", "/api/items", { name, description: name })).json.id;
  const fd = new FormData(); fd.append("photos", new Blob([new Uint8Array([255, 216, 255])], { type: "image/jpeg" }), "p.jpg"); fd.append("kinds", "front");
  const ph = await call("POST", `/api/items/${id}/photos`, fd);
  const add = await call("POST", `/api/garage/sales/${sid}/items`, { item_id: id, price });
  return { id, ph, add };
};
const bike = await quick("Kids' bike, 20 inch", "15");
const lamp = await quick("=cmd lamp", "7.50");
ok("quick add: photo stored, price kept", bike.ph.status === 200 && bike.add.json.price_cents === 1500 && lamp.add.json.price_cents === 750, [bike.ph.json, bike.add.json]);
db.raw.prepare("INSERT INTO appraisals (id,item_id,status,result_json,created_at) VALUES (?,?, 'done', ?, ?)")
  .run(crypto.randomUUID(), bike.id, JSON.stringify({ price_range: { low: 12, high: 25 } }), new Date().toISOString());
r = await call("GET", `/api/garage/sales/${sid}`);
const bikeRow = r.json.items.find(i => i.item_id === bike.id);
ok("sale view: items, thumbs, guestimate range", r.json.items.length === 2 && bikeRow.thumb && bikeRow.guess.low === 12 && bikeRow.guess.high === 25 && r.json.items.find(i => i.item_id === lamp.id).guess === null, r.json.items);
ok("sale link uses the IGS domain", r.json.sale.url.startsWith("https://instantgaragesale.com/sale/"), r.json.sale.url);
await call("PATCH", `/api/garage/sales/${sid}/items/${lamp.id}`, { status: "sold" });

// Export
r = await call("GET", `/api/garage/sales/${sid}/export.csv`);
ok("CSV download headers", r.status === 200 && /text\/csv/.test(r.headers.get("content-type")) && r.headers.get("content-disposition") === 'attachment; filename="big-saturday-sale-2026-10-10-items.csv"', [r.status, r.headers.get("content-disposition")]);
ok("CSV rows: both items, guess, sold, IGS links, formula defused", r.text.includes("Kids' bike, 20 inch") && r.text.includes(",15.00,,,available,,12.00,25.00,https://instantgaragesale.com/sale/") &&
   r.text.includes("'=cmd lamp") && /,7\.50,,,sold,\d{4}-\d\d-\d\d,/.test(r.text), r.text);
r = await call("GET", `/api/garage/sales/${sid}/export.xlsx`);
const zz = unzip(r.buf);
ok("Excel download: xlsx type, real workbook", r.status === 200 && r.headers.get("content-type").includes("spreadsheetml") && zz.endOk && zz.files["xl/worksheets/sheet1.xml"].text.includes("<v>15</v>"), r.headers.get("content-type"));
const saveTo = process.env.IGS_XLSX_OUT; if (saveTo) (await import("node:fs")).writeFileSync(saveTo, r.buf);

// Someone else can't export it
const mine = cookie; cookie = "";
await call("POST", "/api/auth/register", { email: "nosy@example.com", password: "password123" });
ok("other user: 404 on export", (await call("GET", `/api/garage/sales/${sid}/export.csv`)).status === 404 && (await call("GET", `/api/garage/sales/${sid}/export.xlsx`)).status === 404);
cookie = "";
ok("signed out: 401", (await call("GET", `/api/garage/sales/${sid}/export.csv`)).status === 401);
cookie = mine;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

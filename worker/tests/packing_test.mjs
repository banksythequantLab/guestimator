// Run:  node worker/tests/packing_test.mjs
// Stock box / padded mailer choice, item stickers page through the real route.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { packageFor } from "../packing.js";
import { shippingEstimate } from "../appraiser.js";
import { parcelFor } from "../labels.js";
import { itemCode } from "../stickers.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 500) : ""}`)); };

// ---------- packing ----------
const ram = shippingEstimate({ item_weight_lb: 0.1, item_in: [5.3, 1.2, 0.3], fragile: false });
ok("a RAM stick goes in a #0 padded mailer", ram.package.kind === "mailer" && /#0/.test(ram.package.name) && ram.package.box_in.join() === "10,6,1", ram.package);
const gpu = shippingEstimate({ item_weight_lb: 1.5, item_in: [10.5, 4.4, 1.4], fragile: false });
ok("a 1.5 lb GPU gets a box, not a mailer", gpu.package.kind === "box", gpu.package);
ok("the smallest stock box that holds the padded size", gpu.package.box_in.join() === "16,12,8" || (gpu.package.box_in[0] >= 15 && gpu.package.box_in[1] >= 9 && gpu.package.box_in[2] >= 6), gpu.package);
const vase = shippingEstimate({ item_weight_lb: 2, item_in: [10, 6, 6], fragile: true });
ok("fragile never goes in a mailer; box holds 3 in padding", vase.package.kind === "box" && vase.package.box_in[2] >= 12, vase.package);
ok("stock box weighs a bit more than the exact one", vase.package.weight_lb >= vase.packed_weight_lb, [vase.package.weight_lb, vase.packed_weight_lb]);
ok("too big for any stock box -> custom, exact size", packageFor({ box_in: [40, 30, 30], item_weight_lb: 20, packed_weight_lb: 25 }).kind === "custom");
ok("no estimate -> nothing", packageFor(null) === null && packageFor({ box_in: [1, 2] }) === null);
ok("label parcel uses the stock package", parcelFor(ram, null).length === "10" && parcelFor(ram, null).height === "1");
ok("the seller's own measurements still win", parcelFor(ram, { box_in: [8, 6, 4], weight_lb: 0.5 }).length === "8");

// ---------- stickers ----------
ok("item code", itemCode("ccedf352-c38a-4c67-8964-c748e8b493d1") === "G-CCEDF3");
globalThis.fetch = async () => new Response("{}", { status: 404 });
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, ASSETS: { fetch: async () => new Response("asset") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} }, PUBLIC_ORIGIN: "https://g.test" };
let cookie = "";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, redirect: "manual", headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return { status: r.status, text: await r.text(), location: r.headers.get("location"), json: null };
};
let r = await call("GET", "/stickers");
ok("signed out -> sent to sign in", r.status === 302 && r.location === "https://g.test/", r);
await call("POST", "/api/auth/register", { email: "d@example.com", password: "password123" });
const mk = async (name, cents) => { const x = await call("POST", "/api/items", { name, description: name }); const id = JSON.parse(x.text).id; db.raw.prepare("UPDATE items SET price_cents=? WHERE id=?").run(cents, id); return id; };
const a = await mk("Crock <b>", 4500), b = await mk("Lamp", 1250), c = await mk("Sold jug", 900);
db.raw.prepare("UPDATE items SET listing_status='sold' WHERE id=?").run(c);
r = await call("GET", "/stickers");
ok("one sticker per unsold item, sold left off", r.status === 200 && (r.text.match(/class="lb"/g) || []).length === 2 && !r.text.includes("Sold jug"), r.text.slice(0, 300));
ok("code, escaped name, price, and a QR to the item in the app", r.text.includes(itemCode(a)) && r.text.includes("Crock &lt;b&gt;") && r.text.includes("$45") && r.text.includes("$12.50") && r.text.includes(`https://g.test/#item-${a}`));
r = await call("GET", `/stickers?ids=${b}&skip=4`);
ok("one item by id, starting at label 5", (r.text.match(/class="lb"/g) || []).length === 1 && (r.text.match(/class="lb blank"/g) || []).length === 4);
r = await call("GET", "/stickers?plain=1");
ok("plain paper gets cut lines", r.text.includes("dashed"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
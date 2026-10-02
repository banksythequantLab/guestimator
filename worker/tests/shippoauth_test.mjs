// Run:  node worker/tests/shippoauth_test.mjs
// Sellers connect their own Shippo account (OAuth); their labels go on it, not the house account.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as SA from "../shippoauth.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 500) : ""}`)); };
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 11)).toString("base64");
const env0 = { EBAY_TOKEN_KEY: KEY, SHIPPO_OAUTH_CLIENT_ID: "partner_x", SHIPPO_OAUTH_CLIENT_SECRET: "sec" };

const st = await SA.makeState(env0, "user-1", 1000000);
ok("state round-trips", (await SA.readState(env0, st, 1000000 + 60e3)) === "user-1");
ok("state expires after 30 min", (await SA.readState(env0, st, 1000000 + 31 * 60e3)) === null);
ok("forged state refused", (await SA.readState(env0, st.replace("user-1", "user-2"), 1000000)) === null);
ok("authorize URL", SA.authorizeUrl(env0, "s").startsWith("https://goshippo.com/oauth/authorize?response_type=code&client_id=partner_x&scope=*&state=s"));

const calls = [];
const jr = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (u, init = {}) => { const url = String(u); calls.push({ url, auth: init.headers && (init.headers.authorization || init.headers.Authorization), body: init.body });
  if (url === "https://goshippo.com/oauth/access_token") return String(init.body).includes("code=good") ? jr({ access_token: "oauth.TOKEN123", token_type: "bearer" }) : jr({ error: "invalid_grant" }, 400);
  if (url.startsWith("https://api.goshippo.com/shipments")) return jr({ rates: [{ object_id: "r1", amount: "5.10", currency: "USD", provider: "USPS", servicelevel: { token: "usps_ground_advantage" } }] });
  return jr({ errors: [{ message: "unstubbed " + url }] }, 404); };
const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { ...env0, DB: db, ASSETS: { fetch: async () => new Response("a") }, PHOTOS: { put: async () => {}, get: async () => null, delete: async () => {} },
  PUBLIC_ORIGIN: "https://g.test", SHIPPO_API_TOKEN: "house", LABEL_USERS: "boss@example.com" };
let cookie = "";
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { method, redirect: "manual", headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil() {} });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const t = await r.text(); let json = null; try { json = JSON.parse(t); } catch {}
  return { status: r.status, json, location: r.headers.get("location") };
};
await call("POST", "/api/auth/register", { email: "seller@example.com", password: "password123" });
const me = db.raw.prepare("SELECT id FROM users WHERE email='seller@example.com'").get().id;

let r = await call("GET", "/api/labels/settings");
ok("a new seller: not enabled, can connect", r.json.enabled === false && r.json.can_connect === true, r.json);
ok("buying refused until connected", (await call("POST", "/api/labels/rates", { kind: "ebay", order_id: "x" })).status === 403);
r = await call("GET", "/api/labels/connect");
ok("connect gives Shippo's authorize URL with signed state", r.status === 200 && r.json.url.includes("client_id=partner_x") && r.json.url.includes(encodeURIComponent(me + ".")), r.json);
const state = decodeURIComponent(r.json.url.match(/state=([^&]+)/)[1]);
r = await call("GET", `/shippo/callback?code=bad&state=${encodeURIComponent(state)}`);
ok("failed exchange -> back to the app, not connected", r.status === 302 && /shippo=failed/.test(r.location) && (await call("GET", "/api/labels/settings")).json.enabled === false);
r = await call("GET", `/shippo/callback?code=good&state=forged`);
ok("forged state -> refused", /shippo=failed/.test(r.location));
r = await call("GET", `/shippo/callback?code=good&state=${encodeURIComponent(state)}`);
ok("good exchange -> connected", r.status === 302 && /shippo=connected/.test(r.location), r);
const row = db.raw.prepare("SELECT shippo_token_enc t FROM seller_settings WHERE user_id=?").get(me);
ok("token stored sealed, not in plain text", row.t && !row.t.includes("TOKEN123"));
r = await call("GET", "/api/labels/settings");
ok("now enabled, billed to the seller", r.json.enabled === true && r.json.payer === "seller" && r.json.connected === true, r.json);
const le = await SA.labelEnv(env, db, me, false);
const { labelRates } = await import("../labels.js");
await labelRates(le.env, { name: "S", street1: "1 A", city: "X", state: "NJ", zip: "07086" }, { zip: "64106" }, { length: "6", width: "4", height: "4", distance_unit: "in", weight: "1", mass_unit: "lb" });
const sc = calls.filter(c => c.url.startsWith("https://api.goshippo.com/shipments")).pop();
ok("their Shippo token is used (Bearer), not the house token", sc.auth === "Bearer oauth.TOKEN123", sc.auth);
const house = await SA.labelEnv(env, db, "nobody", true);
ok("house account only for LABEL_USERS", house && house.payer === "house" && (await SA.labelEnv(env, db, "nobody", false)) === null);
await call("POST", "/api/labels/disconnect");
ok("disconnect", (await call("GET", "/api/labels/settings")).json.enabled === false);
delete env.SHIPPO_OAUTH_CLIENT_ID;
ok("without Guestimator's partner id, connecting is off", (await call("GET", "/api/labels/connect")).status === 503 && (await call("GET", "/api/labels/settings")).json.can_connect === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
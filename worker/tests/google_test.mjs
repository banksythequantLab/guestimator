// Run:  node worker/tests/google_test.mjs
// Sign in with Google: the popup (JSON) path and the redirect path used on iPhone/iPad Safari,
// with a real RS256 ID token signed by a test key that the stubbed JWKS endpoint serves.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got).slice(0, 500) : ""}`)); };

const CLIENT = "test-client.apps.googleusercontent.com";
const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const b64u = b => Buffer.from(b).toString("base64url");
async function idToken(claims) {
  const h = b64u(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })), p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(h + "." + p));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}
const good = c => idToken({ iss: "https://accounts.google.com", aud: CLIENT, sub: "g-123", email: "ipad@example.com", email_verified: true, exp: Math.floor(Date.now() / 1000) + 600, ...c });
globalThis.fetch = async u => String(u).includes("oauth2/v3/certs") ? new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } }) : new Response("{}", { status: 404 });

const { default: worker } = await import("../worker.js");
const db = d1(join(here, "..", "migrations"));
const env = { DB: db, GOOGLE_CLIENT_ID: CLIENT, PUBLIC_ORIGIN: "https://g.test", ASSETS: { fetch: async () => new Response("a") } };
const send = async (path, init) => {
  const r = await worker.fetch(new Request("https://g.test" + path, { redirect: "manual", ...init }), env, { waitUntil() {} });
  return { status: r.status, location: r.headers.get("location"), cookie: r.headers.get("set-cookie"), json: await r.json().catch(() => null) };
};
const form = (credential, csrf, cookieCsrf) => {
  const fd = new FormData(); if (credential) fd.append("credential", credential); if (csrf) fd.append("g_csrf_token", csrf);
  return { method: "POST", body: fd, headers: cookieCsrf ? { cookie: `g_csrf_token=${cookieCsrf}` } : {} };
};

let r = await send("/api/auth/config");
ok("config: redirect mode off until GOOGLE_REDIRECT=on", r.json.google_redirect === false);
env.GOOGLE_REDIRECT = "on";
ok("config: on when set", (await send("/api/auth/config")).json.google_redirect === true);

r = await send("/api/auth/google", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: await good() }) });
ok("popup path still signs in", r.status === 200 && /bt_session=/.test(r.cookie) && r.json.email === "ipad@example.com", r);

r = await send("/api/auth/google/redirect", form(await good(), "abc", "abc"));
ok("redirect path: signed in, sent home", r.status === 303 && r.location === "/" && /bt_session=/.test(r.cookie), r);
const users = db.raw.prepare("SELECT COUNT(*) n FROM users WHERE email='ipad@example.com'").get().n;
ok("same Google account, one user", users === 1);
r = await send("/api/auth/google/redirect", form(await good(), "abc", undefined));
ok("redirect path: Safari dropped the csrf cookie -> token still verified, signed in", r.status === 303 && r.location === "/" && /bt_session=/.test(r.cookie));
r = await send("/api/auth/google/redirect", form(await good(), "abc", "zzz"));
ok("csrf mismatch -> refused", r.status === 303 && r.location === "/?google=failed" && !r.cookie);
r = await send("/api/auth/google/redirect", form(await good({ aud: "someone-else" }), "abc", "abc"));
ok("token for another app -> refused", r.location === "/?google=failed" && !r.cookie);
r = await send("/api/auth/google/redirect", form(await good({ exp: 1 }), "abc", "abc"));
ok("expired token -> refused", r.location === "/?google=failed" && !r.cookie);
r = await send("/api/auth/google/redirect", form(null, "abc", "abc"));
ok("no token -> refused", r.location === "/?google=failed" && !r.cookie);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

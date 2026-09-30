// Run:  node worker/tests/shipquote_test.mjs
// Shippo quoting, with Shippo stubbed at fetch(). Proves the request we send and how rates are
// read back - NOT that Shippo accepts it; that needs one live call with a real token.
import { quoteShipping, pickRates, suggest, farZip, zip5 } from "../shipping.js";

let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

ok("zip5", zip5(" 07086-1234 ") === "07086" && zip5("abc") === null);
ok("east seller ships far to Seattle", farZip("07086") === "98101");
ok("west seller ships far to Maine", farZip("94110") === "04101");

const R = (token, amount, days = 3, cur = "USD") => ({ servicelevel: { token }, amount: String(amount), currency: cur, estimated_days: days });
const p = pickRates([R("usps_priority", 11.2), R("usps_priority", 10.5), R("usps_ground_advantage", 7.9), R("ups_next_day_air", 55), R("ups_ground", 12), R("usps_priority", 3, 2, "CAD"), R("fedex_ground", 0)]);
ok("keeps cheapest per wanted service", p.usps_priority.amount === 10.5 && p.usps_ground_advantage.amount === 7.9 && p.ups_ground.amount === 12, p);
ok("drops air, zero and foreign-currency rates", !p.ups_next_day_air && !p.fedex_ground && Object.keys(p).length === 3, p);
ok("friendly names", p.usps_priority.service === "USPS Priority Mail");

let s = suggest([{ label: "Nearby", rates: { usps_priority: { service: "USPS Priority Mail", amount: 9.1 } } },
                 { label: "Mid-country", rates: { usps_priority: { service: "USPS Priority Mail", amount: 12.3 }, usps_ground_advantage: { service: "G", amount: 8 } } }]);
ok("suggests mid-country Ground Advantage by default", s.suggested === 8 && /mid-country/.test(s.basis), s);
s = suggest([{ label: "Mid-country", rates: { usps_priority: { service: "USPS Priority Mail", amount: 12.3 }, usps_ground_advantage: { service: "G", amount: 8 } } }], "priority");
ok("suggests Priority when that's the chosen service, rounded up", s.suggested === 13, s);
s = suggest([{ label: "Mid-country", rates: { ups_ground: { service: "UPS Ground", amount: 14.01 } } }]);
ok("falls back to cheapest when no Priority", s.suggested === 15 && s.suggested_service === "UPS Ground", s);
ok("no rates -> null suggestion", suggest([{ label: "Mid-country", rates: {} }]).suggested === null);

// ---- quoteShipping, Shippo stubbed ----
const calls = [];
globalThis.fetch = async (u, init) => {
  const body = JSON.parse(init.body);
  calls.push({ u, auth: init.headers.authorization, body });
  const far = body.address_to.zip !== body.address_from.zip;
  return new Response(JSON.stringify({ rates: [R("usps_priority", far ? 14.4 : 9.6), R("usps_ground_advantage", far ? 9.8 : 6.1)] }), { status: 200 });
};
const env = { SHIPPO_API_TOKEN: "shippo_test_x" };
const est = { box_in: [22, 16, 6], packed_weight_lb: 4.8 };
const q = await quoteShipping(env, "07086", est);
ok("three quotes: near, mid, far", calls.length === 3 && calls.map(c => c.body.address_to.zip).join() === "07086,64106,98101", calls.map(c => c.body.address_to.zip));
ok("ShippoToken auth header", calls.every(c => c.auth === "ShippoToken shippo_test_x"));
ok("ZIP-only quote addresses", JSON.stringify(calls[1].body.address_from) === '{"zip":"07086","country":"US"}');
ok("parcel is the estimated box and packed weight", JSON.stringify(calls[0].body.parcels[0]) === JSON.stringify({ length: "22", width: "16", height: "6", distance_unit: "in", weight: "4.8", mass_unit: "lb" }), calls[0].body.parcels[0]);
ok("synchronous rating", calls[0].body.async === false);
ok("zones labelled", q.zones.map(z => z.label).join("|") === "Nearby|Mid-country|Across the country");
ok("suggested from mid-country Ground Advantage", q.suggested === 10, q);
ok("Priority quote on request", (await quoteShipping(env, "07086", est, "priority")).suggested === 15);

const err = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
let e = await err(() => quoteShipping({}, "07086", est));
ok("no token -> 503 with a plain message", e && e.status === 503);
e = await err(() => quoteShipping(env, "7086", est));
ok("bad ZIP -> 400", e && e.status === 400);
e = await err(() => quoteShipping(env, "07086", null));
ok("no size estimate -> 409 asking for a re-run", e && e.status === 409 && /Re-run/.test(e.message));
globalThis.fetch = async () => new Response(JSON.stringify({ detail: "Invalid token" }), { status: 401 });
e = await err(() => quoteShipping(env, "07086", est));
ok("Shippo error surfaces its message", e && /Invalid token/.test(e.message));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

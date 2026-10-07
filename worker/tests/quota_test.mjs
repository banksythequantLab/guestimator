// Run: node worker/tests/quota_test.mjs
// Service-limit alerts (2026-10-07): SoldComps ran out and estimates quietly fell back to asking prices.
import { d1 } from "./d1shim.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as Q from "../quota.js";
const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log("FAIL " + n + (got !== undefined ? "\n     got " + JSON.stringify(got) : ""))); };
const db = d1(join(here, "..", "migrations"));
const sent = [];
const env = { DB: db, ADMIN_EMAIL: "owner@example.com", EMAIL: { send: async m => { sent.push(m); return { messageId: "x" }; } } };

ok("SoldComps quota is recognised", Q.matchServices(["sold prices unavailable — the sold-price lookup allowance for this month is used up; priced from asking prices"]).map(s => s.key).join() === "soldcomps");
ok("Tavily quota is recognised", Q.matchServices(["the market-search quota is exhausted (429)"]).map(s => s.key).join() === "tavily");
ok("Nebius out of credit is recognised", Q.matchServices(["token factory 402: insufficient balance"]).map(s => s.key).join() === "nebius");
ok("an ordinary warning is not", Q.matchServices(["no sold listing matched this exact item", "price was set by a second pass"]).length === 0);

await Q.checkResult(env, { warnings: ["sold prices unavailable — the sold-price lookup allowance for this month is used up; priced from asking prices"] });
ok("first hit emails the owner", sent.length === 1 && sent[0].to === "owner@example.com" && /SoldComps/.test(sent[0].subject) && /sold-comps\.com/.test(sent[0].text), sent);
await Q.checkResult(env, { warnings: ["sold-price lookup allowance for this month is used up"] });
ok("second hit the same day: counted, not emailed again", sent.length === 1);
let rows = await Q.recentAlerts(db);
ok("owner page sees it with a count", rows.length === 1 && rows[0].hits === 2 && rows[0].name === "SoldComps (sold prices)", rows);
await Q.checkError(env, "token factory 402: insufficient balance");
ok("a failed estimate from Nebius credit emails too", sent.length === 2 && /Nebius/.test(sent[1].subject));
await Q.checkResult(env, { warnings: ["no sales of this in the last 90 days"] });
ok("normal runs add nothing", (await Q.recentAlerts(db)).length === 2 && sent.length === 2);
await Q.checkResult(null, null); await Q.checkError({}, "token factory 429");
ok("never throws, even with no database", true);
console.log("quota_test: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;

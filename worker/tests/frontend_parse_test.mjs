// Run: node worker/tests/frontend_parse_test.mjs
// 2026-10-09: a duplicate top-level `const` in public/app.js (a SyntaxError) blanked the live app
// for ~13 hours while server tests stayed green. Every browser script must at least parse.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
let pass = 0, fail = 0;
for (const f of readdirSync(pub).filter(f => f.endsWith(".js"))) {
  try { new Function(readFileSync(join(pub, f), "utf8")); pass++; }
  catch (e) { fail++; console.log("FAIL " + f + " does not parse: " + e.message); }
}
console.log("frontend_parse_test: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
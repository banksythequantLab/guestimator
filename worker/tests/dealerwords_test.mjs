// Run: node worker/tests/dealerwords_test.mjs
// "What is it?" reaches the appraiser (2026-11-06).
import { dealerWords } from "../appraiser.js";
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log("FAIL " + n + "\n   got " + JSON.stringify(got))); };
let g;
g = dealerWords("Game Boy Color, Atomic Purple", "Console only. Works great, light scratches.");
ok("name leads the description", g === "Game Boy Color, Atomic Purple. Console only. Works great, light scratches.", g);
g = dealerWords("Pokemon Red Version", "Pokemon Red Version Game Boy cartridge only, US");
ok("not repeated when the description already says it", g === "Pokemon Red Version Game Boy cartridge only, US", g);
g = dealerWords("Marantz 2230", "");
ok("name alone is enough", g === "Marantz 2230", g);
g = dealerWords("New item", "brass lamp, 1920s");
ok("app placeholder name ignored", g === "brass lamp, 1920s", g);
g = dealerWords("", "");
ok("nothing -> empty (the 400 still fires)", g === "", g);
g = dealerWords("  Singer 221  ", "with case");
ok("trimmed", g === "Singer 221. with case", g);
g = dealerWords("singer 221", "Singer 221 Featherweight");
ok("case-insensitive repeat check", g === "Singer 221 Featherweight", g);
console.log(`dealerwords: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

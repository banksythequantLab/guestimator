// Run: node worker/tests/casefilter_test.mjs
// Complete vs loose (2026-11-09): the dealer's own words pick which half of a game's market is comparable.
import { caseFilter } from "../appraiser.js";
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log("FAIL " + n + (got !== undefined ? "  got " + JSON.stringify(got) : ""))); };
const H = titles => titles.map(title => ({ title, price: 10 }));
const pool = H([
  "Paper Mario The Thousand-Year Door Nintendo GameCube Disc Only Tested Working",
  "Paper Mario Thousand Year Door (Nintendo GameCube, 2004) Disc Only",
  "Paper Mario: The Thousand-Year Door (GameCube, 2004) Case & Disc",
  "Paper Mario Thousand-Year Door (Nintendo GameCube) CIB - Mint Disc",
  "Paper Mario The Thousand Year Door Nintendo GameCube Complete w/ Manual",
  "Paper Mario TTYD GameCube loose",
  "Paper Mario: The Thousand-Year Door (Nintendo GameCube, 2004) Authentic Tested",
]);
let r = caseFilter("Paper Mario: The Thousand-Year Door for Nintendo GameCube, disc with original case, US version", pool);
ok("with case: disc-only and loose sales dropped", r.dropped === 3 && r.mode === "complete", r);
ok("with case: CIB, case & disc and unlabelled kept", r.kept.length === 4 && r.kept.every(h => !/Disc Only|loose/i.test(h.title)), r.kept.map(h => h.title));
r = caseFilter("Paper Mario TTYD GameCube, disc only, tested", pool);
ok("disc only: complete sales dropped", r.dropped === 3 && r.mode === "loose", r);
ok("disc only: disc-only, loose and unlabelled kept", r.kept.length === 4 && r.kept.every(h => !/CIB|Complete|Case &/i.test(h.title)), r.kept.map(h => h.title));
r = caseFilter("Mario Kart 64 for Nintendo 64, loose cartridge only, US version", H(["Mario Kart 64 N64 CIB complete in box", "Mario Kart 64 (Nintendo 64, 1997) Cartridge Only", "Mario Kart 64 N64 Authentic"]));
ok("cartridge only: CIB dropped", r.dropped === 1 && r.kept.length === 2, r);
r = caseFilter("Zelda Wind Waker GameCube with case, no manual", H(["Wind Waker GameCube Disc Only", "Wind Waker GameCube CIB"]));
ok("with case but no manual still reads as with case", r.mode === "complete" && r.dropped === 1, r);
r = caseFilter("Paper Mario: The Thousand-Year Door for Nintendo GameCube, US version", pool);
ok("dealer said neither: nothing dropped", r.dropped === 0 && r.mode === null, r);
r = caseFilter("Pyrex Spring Blossom mixing bowl, complete set of 4, no box", H(["Pyrex bowl set CIB", "Pyrex bowl loose"]));
ok("not a game: untouched", r.dropped === 0 && r.mode === null, r);
r = caseFilter("Nintendo 64 console NUS-001, console only with power supply, no controller", H(["N64 console complete in box", "N64 console only"]));
ok("console text is not disc/cart text: 'console only' alone does not read as loose", r.mode === null, r);
console.log(`casefilter_test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

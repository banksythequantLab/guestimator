// Run: node worker/tests/casefilter_test.mjs
// Complete vs loose (2026-11-09): the dealer's own words pick which half of a game's market is comparable.
import { caseFilter, soldQueryHint, ebaySold } from "../appraiser.js";
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
// EarthBound (2026-11-09): "w/ Original Box", "Big Box CIB" and "w/ Player's Guide" are complete copies.
r = caseFilter("EarthBound for Super Nintendo SNES, authentic loose cartridge only, US version", H([
  "Nintendo EarthBound SNES Super Nintendo Game Cartridge w/ Original Box", "EarthBound SNES Super Nintendo Big Box CIB Guide Scratch & Sniff Cards Tested",
  "EarthBound w/ Player's Guide (Super Nintendo Entertainment System, 1995)", "Earthbound SNES Cart - Tested Works", "EarthBound SNES (US) | Cartridge Only | Tested and Working"]));
ok("loose: 'w/ Original Box', 'Big Box CIB' and 'w/ Player's Guide' all read as complete", r.dropped === 3 && r.kept.length === 2, r.kept.map(h => h.title));
// Graded and sealed copies go whatever the dealer said about the case, unless theirs is one.
r = caseFilter("Super Mario 64 for Nintendo 64, US version", H(["Super Mario 64 N64 WATA 9.4 A+ Sealed", "Super Mario 64 N64 cartridge tested", "Super Mario 64 (N64) factory sealed", "Super Mario 64 N64 CGC 8.5"]));
ok("graded/sealed dropped with no case mode", r.dropped === 3 && r.mode === null && r.kept.length === 1, r);
r = caseFilter("Super Mario 64 for Nintendo 64, factory sealed, WATA graded 9.0", H(["Super Mario 64 N64 WATA 9.4 A+ Sealed", "Super Mario 64 N64 cartridge tested"]));
ok("dealer's own copy is graded: graded listings kept", r.dropped === 0, r);
r = caseFilter("Mario Kart 64 for Nintendo 64, loose cartridge only", H(["Mario Kart 64 N64 CIB", "Mario Kart 64 N64 sealed", "Mario Kart 64 N64 cart only"]));
ok("loose mode drops both complete and sealed", r.dropped === 2 && r.kept.length === 1, r);
// The sold query asks for complete copies when the dealer has one.
ok("hint: with case -> (cib,complete)", soldQueryHint("Paper Mario TTYD for Nintendo GameCube, disc with original case") === "(cib,complete)");
ok("hint: loose -> none", soldQueryHint("Mario Kart 64 for Nintendo 64, loose cartridge only") === "");
ok("hint: not a game -> none", soldQueryHint("Pyrex bowl set complete with box") === "");
{ const asked = []; const prev = globalThis.fetch;
  globalThis.fetch = async u => { asked.push(new URL(String(u)).searchParams.get("keyword")); return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } }); };
  await ebaySold({ SOLDCOMPS_API_KEY: "k" }, "Paper Mario Thousand-Year Door GameCube", 30, 3, "(cib,complete)");
  globalThis.fetch = prev;
  ok("hint: rides on every rung of the ladder", asked.length >= 2 && asked.every(k => / \(cib,complete\)$/.test(k)), asked); }
console.log(`casefilter_test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

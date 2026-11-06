// Run: node worker/tests/region_test.mjs
// Game region (2026-11-06): Japanese / PAL / import games are not comparables for a US game.
import { wrongRegion, contradictsSpec } from "../appraiser.js";
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : (fail++, console.log("FAIL " + n)); };
const q = "Pokemon Red Version Game Boy cartridge";
ok("japanese pocket monsters rejected", wrongRegion(q, "Tested - Pocket Monsters Red Pokemon Japanese Game Boy Game"));
ok("JPN import rejected", wrongRegion(q, "Pokemon Red Japanese Nintendo Game Boy DMG-APAJ-JPN Import"));
ok("PAL rejected", wrongRegion("Super Mario 64 Nintendo 64 cartridge", "Super Mario 64 N64 PAL cartridge"));
ok("famicom rejected for NES", wrongRegion("Super Mario Bros NES cartridge", "Super Mario Bros Famicom cart"));
ok("US cart kept", !wrongRegion(q, "Authentic Nintendo Pokemon Red Version (Game Boy) Tested"));
ok("japanese wanted -> japanese kept", !wrongRegion("Pocket Monsters Red Japanese Game Boy", "Pocket Monsters Red Japanese Game Boy cartridge"));
ok("not a game: made in Japan kept", !wrongRegion("Noritake china dinner plate", "Vintage Noritake plate made in Japan"));
ok("not a game: camera kept", !wrongRegion("Olympus XA film camera", "Olympus XA 35mm camera Japan"));
ok("wired into contradictsSpec", contradictsSpec(q, "Pocket Monsters Red Japanese Game Boy"));
console.log(`region_test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

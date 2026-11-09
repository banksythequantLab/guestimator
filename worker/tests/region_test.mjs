// Run: node worker/tests/region_test.mjs
// Game region (2026-11-06): Japanese / PAL / import games are not comparables for a US game.
import { wrongRegion, wrongPlatform, contradictsSpec } from "../appraiser.js";
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
// Platform (2026-11-09): the same title on another machine is a different product.
const gc = "Paper Mario: The Thousand-Year Door GameCube game";
ok("switch remake rejected for a gamecube game", wrongPlatform(gc, "Paper Mario: The Thousand-Year Door - Nintendo Switch 2024"));
ok("gamecube original kept", !wrongPlatform(gc, "Paper Mario The Thousand Year Door (Nintendo GameCube, 2004) Complete CIB"));
ok("gamecube spelled 'game cube' kept", !wrongPlatform(gc, "Paper Mario Thousand Year Door Game Cube Tested"));
ok("'plays on Wii' with the platform named is kept", !wrongPlatform(gc, "Paper Mario TTYD GameCube disc - plays on Wii"));
ok("title naming no machine is left to the other filters", !wrongPlatform(gc, "Paper Mario The Thousand-Year Door complete with manual"));
ok("3DS remake rejected for an N64 cart", wrongPlatform("The Legend of Zelda: Ocarina of Time Nintendo 64 cartridge", "Zelda Ocarina of Time 3D Nintendo 3DS"));
ok("wii u port rejected for a gamecube game", wrongPlatform("The Legend of Zelda: The Wind Waker GameCube game", "Zelda Wind Waker HD Wii U"));
ok("ps2 version rejected for an xbox game", wrongPlatform("Halo 2 Xbox game", "Grand Theft Auto PS2") && wrongPlatform("Burnout 3 Takedown Xbox game", "Burnout 3 Takedown PlayStation 2"));
ok("xbox 360 is not xbox", wrongPlatform("Halo 2 original Xbox game", "Halo 2 Xbox 360 Anniversary") && !wrongPlatform("Halo 2 original Xbox game", "Halo 2 (Microsoft Xbox, 2004)"));
ok("game boy family is not checked", !wrongPlatform("Pokemon Crystal Game Boy Color cartridge", "Pokemon Crystal for Game Boy Advance SP GBA Color"));
ok("no platform in the query -> nothing to contradict", !wrongPlatform("Super Mario Bros cartridge", "Super Mario Bros NES"));
ok("not a game at all", !wrongPlatform("Vintage Nintendo Switch plate", "Light switch plate") && !wrongPlatform("Kenwood KR-5600 stereo receiver", "Kenwood receiver with phono switch"));
ok("wired into contradictsSpec", contradictsSpec(gc, "Paper Mario: The Thousand-Year Door Nintendo Switch"));
console.log(`region_test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

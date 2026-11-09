// Run: node worker/tests/fakes_test.mjs
// Counterfeit retro carts (2026-11-09): live FireRed pool that priced an authentic loose cart at $11-$15.
import { fakeFilter, RETRO_CART } from "../appraiser.js";
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log("FAIL " + n + (got !== undefined ? "\n   got " + JSON.stringify(got) : ""))); };
const S = (title, price, condition, extra = {}) => ({ title, price, condition, source: "ebay.com (sold)", sold: true, ...extra });
const L = (title, price, condition = "Used") => ({ title, price, condition, source: "ebay.com", live: true });
const fire = [
  S("Pokemon Fire Red Version Cartridge for Game Boy Advance (GBA) - Tested & Saves!", 13.4, "New (Other)"),
  S("Pokemon Fire Red Version Cartridge for Game Boy Advance (GBA) - Tested", 13.49, "Pre-Owned"),
  S("Pokemon Fire Red Version Cartridge for Game Boy Advance (GBA) - Tested", 9.99, "Brand New"),
  S("Pokemon Fire Red Version Cartridge for Game Boy Advance (GBA)  - Tested & Saves!", 13.99, "New (Other)"),
  S("Pokémon: FireRed Authentic  (Game Boy Advance) Cartridge Only. Tested Save", 48, "Pre-Owned"),
  S("Pokemon FireRed Version GBA Authentic Game Boy Advance Loose Cartridge Tested", 55, "Pre-Owned"),
  L("Pokemon FireRed Version Nintendo Game Boy Advance GBA Tested Cartridge Only RPG", 99.99),
  L("Pokemon Fire Red Version Cartridge for Game Boy Advance (GBA) - Tested", 5.59),
];
const dealer = "Pokemon FireRed Version, Game Boy Advance, loose cartridge only, US version, authentic";
const f = fakeFilter(dealer, fire);
const titles = f.kept.map(h => h.price);
ok("FireRed: new-condition sales dropped", !titles.includes(13.4) && !titles.includes(9.99) && !titles.includes(13.99), titles);
ok("FireRed: cheap unmarked pre-owned copy dropped", !titles.includes(13.49) && !titles.includes(5.59), titles);
ok("FireRed: authentic sales kept", titles.includes(48) && titles.includes(55), titles);
ok("FireRed: ordinary higher listing kept", titles.includes(99.99), titles);
ok("FireRed: count", f.dropped === 5, f.dropped);
ok("dealer selling a sealed copy: untouched", fakeFilter("Pokemon FireRed GBA, factory sealed, new", fire).dropped === 0);
ok("not a retro cart: untouched", fakeFilter("Nintendo Switch Lite console", [S("Switch Lite", 150, "Brand New")]).dropped === 0);
ok("pottery: untouched", fakeFilter("Pyrex Butterprint bowl set", [S("Pyrex bowls", 40, "Brand New")]).dropped === 0);
const noAuth = [S("Super Metroid SNES cartridge", 90, "Pre-Owned"), S("Super Metroid SNES cart tested", 25, "Pre-Owned"), S("Super Metroid SNES", 85, "Brand New")];
const g = fakeFilter("Super Metroid, SNES, loose cartridge", noAuth);
ok("no authentic markers: only new-condition rule applies", g.dropped === 1 && g.kept.map(h => h.price).join() === "90,25", g.kept);
ok("one authentic is not enough to judge", fakeFilter("Pokemon Red Game Boy cartridge", [S("Pokemon Red authentic", 60, "Used"), S("Pokemon Red", 10, "Used")]).dropped === 0);
ok("hits without a condition are kept", fakeFilter("Kirby 64 N64 cartridge", [{ title: "Kirby 64", price: 40 }]).dropped === 0);
ok("retro detector", RETRO_CART.test("Game Boy Advance cartridge") && RETRO_CART.test("N64 cart") && !RETRO_CART.test("PlayStation 2 Slim"));
// DS Pokemon (2026-11-09): the same two rules apply to DS and 3DS carts.
{ const hg = [S("Pokemon HeartGold Version DS Tested Saves", 24, "Brand New"), S("Pokemon HeartGold Nintendo DS Authentic Tested", 115, "Pre-Owned"), S("Pokemon HeartGold Authentic US DS Cartridge", 120, "Pre-Owned"), S("Pokemon HeartGold DS game", 22, "Pre-Owned"), S("Pokemon HeartGold (Nintendo DS) cart only", 108, "Pre-Owned")];
  const r = fakeFilter("Pokemon HeartGold Version for Nintendo DS, authentic loose cartridge only", hg);
  ok("DS: new-condition and under-40%-of-authentic sales dropped", r.dropped === 2 && r.kept.length === 3 && r.kept.every(h => h.price >= 100), r.kept.map(h => h.price));
  ok("DS covered by RETRO_CART", RETRO_CART.test("Pokemon SoulSilver Nintendo DS cartridge") && RETRO_CART.test("Mario Kart 7 3DS game") && !RETRO_CART.test("Seiko SKX007 dive watch")); }
console.log(`fakes: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

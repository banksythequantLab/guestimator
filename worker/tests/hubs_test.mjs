// Run: node worker/tests/hubs_test.mjs
// Price-guide category hubs (2026-11-06).
import { HUBS, hubOf, hubBySlug, hubPage, indexPage, guidePage, sitemap, pagePath } from "../priceguide.js";
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log("FAIL " + n + (got !== undefined ? "\n   got " + JSON.stringify(got).slice(0, 300) : ""))); };
let seq = 1000000000;
const G = (title, category = null) => ({ listing_id: String(seq++), title, range: { low: 10, high: 20 }, about: { category }, comps: [], estimated_at: "2026-11-06", updated_at: "2026-11-06" });
const h = t => hubOf(G(t)).slug;
const cases = [
  ["Banjo-Kazooie Nintendo 64 cartridge", "video-games"], ["Nintendo Game Boy Pocket MGB-001 handheld video game console", "video-games"],
  ["Sony PSP 3000 handheld game console", "video-games"], ["Sega Saturn console", "video-games"], ["Microsoft Xbox original console", "video-games"],
  ["Pokémon Red Version Game Boy cartridge", "video-games"], ["Canon AE-1 Program 35mm film camera body", "film-cameras"],
  ["Mamiya C330 Professional TLR camera body", "film-cameras"], ["Polaroid SX-70 Land Camera folding instant camera", "film-cameras"],
  ["Marantz 2220B vintage stereo receiver", "vintage-audio"], ["Technics SL-1200MK2 Turntable", "vintage-audio"],
  ["Singer Featherweight 221 sewing machine with case and pedal", "sewing-machines"], ["Bernina 830 Record sewing machine", "sewing-machines"],
  ["Griswold No. 8 cast iron skillet", "kitchen"], ["Vintage Pyrex Butterprint mixing bowl set, 4 nesting bowls, turquoise on white", "kitchen"],
  ["KitchenAid K5-A Stand Mixer", "kitchen"], ["Le Creuset 5.5-quart Round Dutch Oven", "kitchen"], ["Corning Ware Blue Cornflower 2‑quart casserole dish with glass lid", "kitchen"],
  ["Seiko SKX007 automatic dive watch", "watches"], ["Timex Marlin Mechanical Hand-Wind Men's Watch", "watches"],
  ["SK hynix 32GB DDR4 2400MHz ECC Registered RDIMM Server Memory Module", "computer-parts"], ["NVIDIA Tesla M10 Graphics Card", "computer-parts"],
  ["Texas Instruments TI-84 Plus graphing calculator", "computer-parts"], ["Apple iPod Classic 160GB 7th Generation Silver", "computer-parts"],
  ["Goebel Hummel figurine Apple Tree Girl", "more"], ["Harold Hayden 12x18 oil painting on canvas, abstract figurative style", "more"],
  ["Stanley Sweetheart No. 4 smoothing hand plane", "more"], ["Ray-Ban Wayfarer sunglasses, black, model 5022", "more"],
];
for (const [t, want] of cases) ok(`${t} -> ${want}`, h(t) === want, h(t));
ok("category used when title says nothing", hubOf(G("Model 7 thing", "Wristwatch")).slug === "watches");
ok("unknown slug", hubBySlug("nope") === null && hubBySlug("watches").name === "Watches");

const guides = [G("Seiko SKX007 automatic dive watch"), G("Timex Marlin watch"), G("Super Mario 64 Nintendo 64 cartridge"), G("Goebel Hummel figurine")];
const o = "https://app.theguestimator.com";
const hp = hubPage(hubBySlug("watches"), guides, o);
ok("hub lists its items", hp.includes(pagePath(guides[0])) && hp.includes(pagePath(guides[1])));
ok("hub leaves other items out", !hp.includes(pagePath(guides[2])));
ok("hub links other categories", hp.includes('href="/prices/video-games"') && hp.includes('href="/prices/more"'));
ok("hub canonical", hp.includes(`<link rel="canonical" href="${o}/prices/watches">`));
ok("hub breadcrumb + itemlist", /"BreadcrumbList"/.test(hp) && /"ItemList"/.test(hp));
const ix = indexPage(guides, o);
ok("index links every hub with items", ["watches", "video-games", "more"].every(s => ix.includes(`href="/prices/${s}"`)) && !ix.includes('href="/prices/kitchen"'));
ok("index still links every item", guides.every(g => ix.includes(pagePath(g))));
const ip = guidePage(guides[0], o, guides);
ok("item page links its hub", ip.includes('<a href="/prices/watches">Watches</a>'));
ok("item breadcrumb has 3 levels", /"position":3/.test(ip) && ip.includes(`"item":"${o}/prices/watches"`));
ok("more: same hub first", ip.indexOf(pagePath(guides[1])) > 0 && ip.indexOf(pagePath(guides[1])) < ip.indexOf(pagePath(guides[2])));
ok("more: never links itself", ip.split(`href="${pagePath(guides[0])}"`).length === 1);
const sm = sitemap(guides, o);
ok("sitemap has hubs", sm.includes(`${o}/prices/watches<`) && sm.includes(`${o}/prices/video-games<`) && !sm.includes("/prices/kitchen<"));
ok("sitemap still has items", guides.every(g => sm.includes(o + pagePath(g))));
{ const tc = HUBS.find(h => h.slug === "trading-cards");
  ok("cards hub: Charizard card is a card", hubOf({ title: "Pokémon Base Set Charizard 4/102 holo card" }) === tc);
  ok("cards hub: Griffey rookie is a card", hubOf({ title: "1989 Upper Deck Ken Griffey Jr. #1 rookie card" }) === tc);
  ok("cards hub: TCG game cartridge stays a game", hubOf({ title: "Pokemon Trading Card Game Game Boy Color cartridge" }).slug === "video-games");
  ok("cards hub: Pokemon Red cartridge stays a game", hubOf({ title: "Pokémon Red Version Game Boy cartridge" }).slug === "video-games");
  ok("cards hub: graphics card stays a computer part", hubOf({ title: "NVIDIA Tesla M10 Graphics Card" }).slug === "computer-parts"); }
console.log(`hubs: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

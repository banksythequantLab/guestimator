// Run: node worker/tests/articles_test.mjs
// Guide pages built from live price-guide data (2026-11-06).
import { ARTICLES, articleBySlug, articlePage, articlePath, indexPage, hubPage, hubBySlug, sitemap, pagePath, HUBS } from "../priceguide.js";
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log("FAIL " + n + (got !== undefined ? "\n   got " + JSON.stringify(got).slice(0, 300) : ""))); };
let seq = 1000000000;
const G = (title, low, high, extra = {}) => ({ listing_id: String(seq++), title, range: { low, high }, about: {}, comps: [], estimated_at: "2026-11-06T10:00:00Z", updated_at: "2026-11-06", ...extra });
const guides = [G("Super Metroid SNES cartridge", 81, 109), G("Duck Hunt NES cartridge", 4, 6), G("Rare thin game cartridge", 500, 900, { thin: true }),
  G("Nikon F3 35mm film camera body", 276, 431), G("Griswold No. 10 cast iron skillet", 162, 232)];
const o = "https://g.test";
ok("every article points at a real hub", ARTICLES.every(a => HUBS.some(h => h.slug === a.hub)), ARTICLES.map(a => a.hub));
ok("slugs unique", new Set(ARTICLES.map(a => a.slug)).size === ARTICLES.length);
const a = articleBySlug("old-video-games-worth");
const p = articlePage(a, guides, o);
ok("title and canonical", p.includes("<title>How much are my old video games worth? | Guestimator</title>") && p.includes(`<link rel="canonical" href="${o}/guides/old-video-games-worth">`));
ok("table quotes live prices, highest first", p.indexOf("Super Metroid") > 0 && p.indexOf("Super Metroid") < p.indexOf("Duck Hunt") && p.includes("$81–$109"));
ok("links the item pages it quotes", p.includes(`href="${pagePath(guides[0])}"`));
ok("thin pages are not quoted", !p.includes("Rare thin game"));
ok("other categories not quoted", !p.includes("Nikon F3") && !p.includes("Griswold"));
ok("as-of date", p.includes("updated 2026-11-06"));
ok("steps + tips + CTA", p.includes("How to find out what yours is worth") && p.includes("What moves the price") && p.includes("utm_source=price_guide_article"));
ok("Article + FAQ markup", /"@type":"Article"/.test(p) && /"@type":"FAQPage"/.test(p));
ok("FAQ answer uses real range", /between \$4 and \$109/.test(p), p.match(/between [^.]+/));
ok("unknown slug", articleBySlug("nope") === null);
ok("index links all guides", ARTICLES.every(x => indexPage(guides, o).includes(`href="${articlePath(x)}"`)));
ok("hub links its guide", hubPage(hubBySlug("film-cameras"), guides, o).includes(`href="/guides/old-film-camera-worth"`));
const sm = sitemap(guides, o);
ok("sitemap lists guides", ARTICLES.every(x => sm.includes(`${o}${articlePath(x)}<`)));
const empty = articlePage(articleBySlug("vintage-stereo-worth"), [], o);
ok("no data: still renders, no table", empty.includes("What is my vintage stereo") && !empty.includes("<table>"));
const ci = articlePage(articleBySlug("cast-iron-skillet-worth"), [...guides, G("Vintage Pyrex Butterprint mixing bowl set", 184, 249)], o);
ok("cast iron guide quotes pans, not Pyrex", ci.includes("Griswold No. 10") && !ci.includes("Pyrex Butterprint"));
const con = articlePage(articleBySlug("old-game-console-worth"), [...guides, G("Sega Dreamcast HKT-3020 console", 75, 102), G("Nintendo DS Lite handheld gaming console", 50, 72)], o);
ok("console guide quotes consoles, not cartridges", con.includes("Sega Dreamcast") && con.includes("DS Lite") && !con.includes("Super Metroid"));
ok("sewing guide exists", !!articleBySlug("old-sewing-machine-worth") && ARTICLES.length === 13);
// Platform guides (2026-11-09): each quotes its own platform's games, never consoles or another platform.
{ const plat = [...guides, G("Super Smash Bros. Melee GameCube game", 45, 60), G("Mario Kart Wii game", 28, 40), G("Nintendo Wii (RVL-001) console", 40, 60),
    G("GameCube DOL-001 console (Indigo)", 80, 110), G("Super Mario 64 N64 cartridge", 30, 45), G("Nintendo 64 console (NUS-001)", 47, 69), G("Zelda Wind Waker GameCube game", 60, 80)];
  const gc = articlePage(articleBySlug("gamecube-games-worth"), plat, o);
  ok("gamecube guide: GameCube games only", gc.includes("Melee") && gc.includes("Wind Waker") && !gc.includes("DOL-001") && !gc.includes("Mario Kart Wii") && !gc.includes("Super Metroid"), gc.match(/<tbody>.*<\/tbody>/s)?.[0]?.slice(0, 400));
  const wii = articlePage(articleBySlug("wii-games-worth"), plat, o);
  ok("wii guide: Wii games only", wii.includes("Mario Kart Wii") && !wii.includes("RVL-001") && !wii.includes("Melee"));
  const n64 = articlePage(articleBySlug("n64-games-worth"), plat, o);
  ok("n64 guide: N64 carts only", n64.includes("Super Mario 64") && !n64.includes("NUS-001") && !n64.includes("Super Metroid"));
  const snes = articlePage(articleBySlug("snes-games-worth"), plat, o);
  ok("snes guide: SNES carts only", snes.includes("Super Metroid") && !snes.includes("Super Mario 64") && !snes.includes("Duck Hunt")); }
const pc = articlePage(articleBySlug("old-pokemon-cards-worth"), [...guides, G("Pokémon Base Set Charizard 4/102 holo card (Unlimited)", 307, 442), G("Lugia 9/111 Neo Genesis holo card", 90, 130), G("1989 Upper Deck Ken Griffey Jr. #1 rookie card", 77, 104)], o);
ok("pokemon card guide quotes Pokemon cards, not sports cards or games", pc.includes("Charizard 4/102") && pc.includes("Lugia") && !pc.includes("Griffey") && !pc.includes("Super Metroid"));
const pk = articlePage(articleBySlug("old-pokemon-games-worth"), [...guides, G("Pokemon Red Version Game Boy cartridge", 40, 62), G("Pokémon Snap Nintendo 64 cartridge", 20, 30)], o);
ok("pokemon guide quotes only Pokemon games", pk.includes("Pokemon Red") && pk.includes("Pokémon Snap") && !pk.includes("Super Metroid") && !pk.includes("Duck Hunt"));
const wt = articlePage(articleBySlug("vintage-watch-worth"), [...guides, G("Seiko SKX007 automatic dive watch", 250, 340)], o);
ok("watch guide quotes watches", wt.includes("Seiko SKX007") && !wt.includes("Nikon F3"));
ok("watches hub links its guide", hubPage(hubBySlug("watches"), guides, o).includes(`href="/guides/vintage-watch-worth"`));
console.log(`articles: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

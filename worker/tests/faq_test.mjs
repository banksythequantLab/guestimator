// Run: node worker/tests/faq_test.mjs
// Price-page questions from the page's own data + hub tips (2026-11-06).
import { itemFaq, hubPage, hubBySlug, guidePage, HUBS } from "../priceguide.js";
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log("FAIL " + n + (got !== undefined ? "\n   got " + JSON.stringify(got).slice(0, 400) : ""))); };
const g = { listing_id: "g0123456789ab", title: "Nintendo Game Boy Color Atomic Purple", range: { low: 60, high: 88 }, about: {},
  sold: { count: 4, median: 70 }, market: { count: 2, low: 85, high: 98, median: 91 }, estimated_at: "2026-11-06T10:00:00Z", updated_at: "2026-11-06",
  comps: [{ title: "Game Boy Color Atomic Purple CGB-001 Tested", price: 69, sold: true }, { title: "GBC Atomic Purple handheld", price: 90, sold: true }, { title: "asking one", price: 98, sold: false }] };
const f = itemFaq(g);
ok("three questions", f.length === 3, f);
ok("worth answer uses this page's numbers", /\$60 to \$88/.test(f[0].a) && /4 recent eBay sales/.test(f[0].a) && /median of \$70/.test(f[0].a) && /2026-11-06/.test(f[0].a), f[0].a);
ok("asking prices called out as higher", /\$85 to \$98/.test(f[0].a) && /asking prices run higher/.test(f[0].a), f[0].a);
ok("sold answer lists only sold comps", /\$69/.test(f[1].a) && /\$90/.test(f[1].a) && !/\$98/.test(f[1].a), f[1].a);
ok("tips answer comes from the hub", f[2].a.startsWith(hubBySlug("video-games").tips[0]), f[2].a);
const thin = itemFaq({ ...g, sold: null, market: null, thin: true, comps: [] });
ok("thin page: one question, says rough guess, no sold question", thin.length === 2 && /rough guess/.test(thin[0].a) && !thin.some(q => /sold for recently/.test(q.q)), thin);
const page = guidePage(g, "https://g.test", []);
ok("page shows the questions", page.includes("Common questions") && page.includes("How much is a Nintendo Game Boy Color Atomic Purple worth?"));
ok("FAQPage markup", /"@type":"FAQPage"/.test(page) && /"acceptedAnswer"/.test(page));
ok("no null in JSON-LD", !/,null[,\]]|\[null/.test(page));
const hp = hubPage(hubBySlug("film-cameras"), [], "https://g.test");
ok("hub shows what moves the price", hp.includes("What moves the price") && hp.includes("light meter"));
ok("every hub has tips", HUBS.every(h => Array.isArray(h.tips) && h.tips.length >= 3), HUBS.map(h => h.slug + ":" + (h.tips || []).length));
console.log(`faq: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

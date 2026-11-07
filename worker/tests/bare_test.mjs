// Run: node worker/tests/bare_test.mjs
// "Console only" / "body only" (2026-11-06): bundles and refurbished units are not what a bare item sells for.
import { BARE_ONLY, EXTRAS, bareFilter } from "../appraiser.js";
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log("FAIL " + n + (got !== undefined ? "\n     got " + JSON.stringify(got) : ""))); };
ok("hyphenated count is an extra", EXTRAS.test("2-CONTROLLERS Original SEGA Genesis") && EXTRAS.test("Sega Genesis 3-games") && !EXTRAS.test("Sega Genesis Model 1 MK-1601 console only"));
ok("console only is bare", BARE_ONLY.test("Original Microsoft Xbox console only, working"));
ok("body only is bare", BARE_ONLY.test("Canon AE-1 35mm film camera body only, black"));
ok("no controllers is bare", BARE_ONLY.test("Dreamcast, no controllers"));
ok("a plain description is not", !BARE_ONLY.test("Singer 221 sewing machine with case and pedal"));
for (const t of ["2001 Original Microsoft Xbox console Controls & Dvd Remote", "Original OG Xbox Complete Console With 2 Controller & 10 Games",
  "Original Microsoft Xbox Console only - Fully reconditioned & tested", "Original Xbox Console Bundle Halo 1 & 2 Games + Controller",
  "SEGA Dreamcast HKT-3020 White Console w/ Controller & Cables", "Sega Dreamcast Console HKT-3020 w/ Controller, Cables & Games",
  "Canon AE-1 Program with 50mm f/1.8 lens", "Nintendo 64 console + 3 games", "PS2 slim lot of games", "Super Nintendo CIB"])
  ok("extras: " + t, EXTRAS.test(t));
for (const t of ["Original Microsoft Xbox Console Only Black Tested Works", "SEGA Dreamcast HKT-3020 Console Only Tested",
  "Canon AE-1 35mm Film SLR Camera Body Only - TESTED - Works!", "Nintendo NES-001 Console Only Tested Working",
  "Sony PlayStation 2 Slim SCPH-90001 Console Only Black", "Sega Dreamcast console with power and AV cables"])
  ok("bare listing kept: " + t, !EXTRAS.test(t));
const hits = [{ title: "Xbox Console Only Tested" }, { title: "Xbox Bundle 2 controllers 5 games" }, { title: "Xbox console w/ controller" }];
let f = bareFilter("Original Xbox console only", hits);
ok("filter drops the bundles", f.kept.length === 1 && f.dropped === 2, f);
f = bareFilter("Original Xbox console", hits);
ok("nothing dropped when the dealer did not say only", f.kept.length === 3 && f.dropped === 0, f);
ok("tolerates empty input", bareFilter("console only", null).kept.length === 0);
console.log(`bare_test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

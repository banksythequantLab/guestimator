// Run: node worker/tests/deny_test.mjs
import { deniedTerms, scrubDenied } from "../appraiser.js";
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log("FAIL " + n + (got !== undefined ? "\n     got " + JSON.stringify(got) : ""))); };
const said = "Cabinet 59 x 29. Is the paint finish original: Orginal. No uhaul sign it is a box sitting next to it. Size: 59 x 29 x 29 inches.";
ok("finds the denied brand", JSON.stringify(deniedTerms(said)) === JSON.stringify(["uhaul"]), deniedTerms(said));
ok("'not part of it' form", deniedTerms("The coca cola sign is not part of it").includes("cocacola"));
ok("ordinary answers deny nothing", deniedTerms("No chips or cracks. No markings found. Any labels: none").length === 0, deniedTerms("No chips or cracks. No markings found. Any labels: none"));
const r = scrubDenied({ identification: { name: "Painted wood cabinet decorated with 'PEACE TO YOU' and U-Haul motifs" },
  listing: { title: 'Painted Wood Cabinet with "Peace To You" and UHaul Graphics', description: "A midcentury painted cabinet. U-Haul references add whimsy. Paneled doors.", tags: ["cabinet", "uhaul", "folk art"] },
  evidence: ["Paneled doors", "U-Haul references suggest moving theme"] }, said);
ok("name scrubbed", r.identification.name === "Painted wood cabinet decorated with 'PEACE TO YOU'", r.identification.name);
ok("title scrubbed", r.listing.title === 'Painted Wood Cabinet with "Peace To You"', r.listing.title);
ok("description sentence dropped", r.listing.description === "A midcentury painted cabinet. Paneled doors.", r.listing.description);
ok("tag + evidence dropped", r.listing.tags.join() === "cabinet,folk art" && r.evidence.join() === "Paneled doors");
const same = { identification: { name: "U-Haul medium moving box" } };
ok("nothing said -> untouched", scrubDenied(same, "Size: 10 x 10 x 10 inches.").identification.name === "U-Haul medium moving box");
console.log("deny_test: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;

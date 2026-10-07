// Run:  node worker/tests/speedcap_test.mjs
// Speed cap (2026-10-07): a sold-price lookup that hangs is cut off at SEARCH_CAP_MS and skipped
// with a reason, instead of holding the estimate up for 20s.
let pass = 0, fail = 0;
const ok = (n, c, got) => { c ? pass++ : (fail++, console.log(`FAIL ${n}${got !== undefined ? "\n     got " + JSON.stringify(got) : ""}`)); };

// A SoldComps that never answers until the request is aborted.
globalThis.fetch = (u, init = {}) => new Promise((_, reject) => {
  init.signal && init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
});
const A = await import("../appraiser.js");

ok("default cap is 10s", A.searchCapMs({}) === 10000);
ok("cap is configurable and bounded", A.searchCapMs({ SEARCH_CAP_MS: "4000" }) === 4000 && A.searchCapMs({ SEARCH_CAP_MS: "1" }) === 3000 && A.searchCapMs({ SEARCH_CAP_MS: "999999" }) === 30000);

const t0 = Date.now();
const r = await A.ebaySold({ SOLDCOMPS_API_KEY: "k", SEARCH_CAP_MS: "3000" }, "SK Hynix 32GB DDR4 2400 RDIMM");
const took = Date.now() - t0;
ok("hung lookup gives up at the cap", r === null && took >= 2900 && took < 6000, { r, took });
ok("and says why", /took longer than 3 seconds, so it was skipped/.test(String(A.soldFailure())), A.soldFailure());

console.log(`speedcap_test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

// Live smoke check: loads the live Guestimator app in Chromium and fails on a blank page or a
// script error. Run: node scripts/live-smoke.mjs   (needs the playwright package + chromium)
import { chromium } from "playwright";
const ORIGIN = process.env.SMOKE_ORIGIN || "https://app.theguestimator.com";
const problems = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("pageerror", e => problems.push("script error: " + e.message));
  const res = await page.goto(ORIGIN + "/", { waitUntil: "load", timeout: 30000 });
  if (!res || res.status() !== 200) problems.push(`home page status ${res && res.status()}`);
  await page.waitForTimeout(4000);
  const text = await page.innerText("body");
  // The signed-out landing that app.js renders; the bare HTML shell only has the header.
  if (!/What's it worth/i.test(text) || text.length < 300) problems.push(`app did not render (body text ${text.length} chars)`);
  for (const path of ["/market", "/market-terms", "/prices"]) {
    const r = await page.request.get(ORIGIN + path);
    if (r.status() !== 200) problems.push(`${path} returned ${r.status()}`);
  }
} catch (e) {
  problems.push("check crashed: " + e.message);
} finally {
  await browser.close();
}
if (problems.length) { console.error("LIVE SMOKE FAILED\n- " + problems.join("\n- ")); process.exit(1); }
console.log("Live smoke OK: app rendered, no script errors, Market pages up.");
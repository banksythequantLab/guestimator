# Guestimator: What's It Worth? — RevenueCat Shipaton 2026

Paste-ready submission. Replaces DEVPOST_SHIPATON.md (the Bottle Tree version).
Deadline: **Sept 30, 2026, 11:45 pm PDT**. Lines marked **TODO** need Derek before submitting;
every other claim below is true as of Sep 27 and says so where it is only partly done.

---

## Submission fields

| Field | Value |
| --- | --- |
| Project name | Guestimator: What's It Worth? |
| Tagline | Snap it, get a price from live eBay comparables, and list it on your own eBay account in a tap. |
| Platform | Android (Google Play) + web |
| Package | `ai.banksy.bottletree` (kept from the Bottle Tree build so purchases and sign-in carry over) |
| Store link | https://play.google.com/store/apps/details?id=ai.banksy.bottletree — **TODO** confirm it shows "Guestimator" once Google approves the update |
| Test link (works now) | https://play.google.com/apps/internaltest/4700209593663356261 |
| Web app | https://app.theguestimator.com |
| Website | https://theguestimator.com |
| Video (<=2 min) | **TODO** — `guestimator_demo_vo.mp4` (Derek's cloned voice-over) is 1:57 (trimmed, full narration); upload to YouTube, paste link |
| Judges: free credits | Sign up at https://app.theguestimator.com (or in the Android app), tap the credits pill at the top, and enter **10FREECREDITS** under "Have a code?". That adds 10 free credits (10 estimates or eBay listings), once per account, no card needed. |
| Repo | https://github.com/banksythequantLab/guestimator (public) |
| Team | Derek Soltis — Banksy AI LLC |
| Categories | #BuildInPublic · Best Business / Productivity App |

---

## Inspiration

Everyone who has stood at a garage sale or cleared out a relative's house knows the question:
what is this actually worth? The honest answer used to take an hour and a laptop: searching
listings, squinting at a maker's mark, guessing. And once you know, you still have to write the
eBay listing.

Guestimator started life as Bottle Tree, a point-of-sale app for antique shops with an AI
appraiser bolted on. Using it ourselves, the appraiser was the part we kept reaching for, and the
comparables it pulled were the part we trusted. So mid-Shipaton we split it out: drop the cash
register, keep the estimate, and add the thing we'd pay for ourselves. That is listing the item
on eBay for you.

## What it does

**Price it.** Photograph an item from a few angles and type what you know. Guestimator
identifies it and prices it from what comparable items are listed for on eBay right now, and
shows you those listings so you can check the number yourself. For silver and gold it works
out melt value as a floor. When two identifications are plausible it asks you instead of
guessing.

**List it.** Connect your own eBay account (or follow the link to create one) and Guestimator
writes the listing: category (from eBay's own taxonomy), item specifics (filled from the
estimate, restricted to eBay's allowed values), condition (only ones that category accepts),
photos, description and a starting price from the comparables. You review every field, set
your ZIP and shipping, and tap List. Nothing is listed without your approval.

**Metered with RevenueCat.** One credit pays for one estimate or one eBay listing, from the same
balance: $0.99 for 1 credit, $4.99 for 10, $9.99/month for 300 (split any way between estimates
and listings), $29.99/month unlimited. On Android, purchases go through Google Play Billing; on the web, through RevenueCat Web Billing checkout. Both land in the same RevenueCat project and the same credit balance. Previewing a listing and eBay's fee quote is free; a
listing eBay rejects refunds its credit automatically. One account works on Android and the web.

## How we built it

**App.** A Capacitor 8 shell around the live web app, plus `@revenuecat/purchases-capacitor`.
The web app detects the native bridge and swaps its web paywall for RevenueCat offerings with
live Play prices. Google sign-in uses Credential Manager natively and Google Identity Services
on the web; both produce the same ID token.

**Backend.** A Cloudflare Worker with D1, R2 and Queues. It keeps a credits-and-plans ledger with
an atomic "consume estimate" (unlimited, then plan cap, then credits, then a 402 paywall),
automatic refunds when a run fails, and a RevenueCat webhook that is idempotent on event id and
treats refunds correctly. RevenueCat has no REFUND event; a refund arrives as CANCELLATION with a
cancel_reason, and we read it that way.

**Appraiser.** Runs inside the Worker on Nebius Token Factory. Gemma 3 27B reads the photos and
NVIDIA Nemotron 3 Super reasons over an evidence sheet. Live comparables come from the eBay
Browse API, with Tavily as backfill.

**eBay listing.** The user's own eBay account via OAuth. We store refresh tokens AES-GCM
encrypted and honour eBay's marketplace account-deletion notices. Listings go through the Sell
Inventory API (inventory item, offer, publish), using the Taxonomy and Metadata APIs to pick
category, item specifics and legal conditions. If the seller has no business policies,
Guestimator creates payment, return and flat-rate shipping policies for them.

## Challenges we ran into

**The empty price.** A phone test came back with four good comparables ($190-$390) and no price
at all. The re-pricing model had returned its own blank template, all zeros, and a truthiness
check accepted it. The fix is a real "is this a usable price" test, plus a warning when no price
could be set, so the app never shows a silent $0.

**eBay categories are not uniform.** Calling eBay's live Metadata API showed that some
categories, like Antiques > Silverplate flatware, take no condition at all. Sending one there
would have failed the listing at publish time, after the credit was spent. Condition now comes
from the category's own list, or is left out.

**Stale native builds.** The app loads its UI live, but permissions and plugins only change with
a new build. The camera was blocked on a phone because that build predated the CAMERA
permission. Lesson: every native change means a new versionCode, every time.

## Accomplishments we're proud of

- The estimate on real objects. A cast-iron fluting iron with a worn 1878 patent stamp was
  identified as Shepard Hardware Co. of Buffalo, $120-250. An Intel Optane module was priced
  from four live eBay comparables.
- Money handling that is tested, not assumed. 664 automated checks, including the full eBay
  flow (connect, draft, publish, refusal, refund, retry, account deletion) and promo-code
  redemption against a real
  database, with eBay stubbed at the network layer. Key rules were checked by breaking them on
  purpose and confirming the tests fail.
- The RevenueCat loop runs end to end through RevenueCat's test store: paywall, purchase,
  webhook, credits written, balance updates without a reload. **TODO:** a first real Google
  Play purchase. Until then, don't claim "verified on a device with a real purchase".
- Real listings on eBay, made through Guestimator on Sep 27, 2026: an Intel Optane 256GB DCPMM
  at $180 (eBay item 198671504189) and an SK Hynix 16GB DDR4 ECC RDIMM at $95 (eBay item
  198671529701). Each used one Guestimator credit.

## What we learned

Meter the thing that costs money, and make the paid feature the one people would pay for
anyway. For us that turned out to be "just list it for me", not the cash register. And read the
platform's metadata instead of assuming: eBay's conditions, RevenueCat's event types and Play's
product IDs all turned out different from what we'd have guessed.

## What's next

Etsy and Facebook Marketplace crosslisting, sold-price history alongside asking prices, and
iOS once the Apple developer account clears.

## Built with

android · capacitor · revenuecat · cloudflare-workers · cloudflare-d1 · cloudflare-r2 ·
cloudflare-queues · ebay-api · nvidia-nemotron · gemma · nebius · tavily · javascript

## Shipaton checklist

- [x] New app, built during the Shipaton (Bottle Tree, then Guestimator split out Sep 27)
- [x] RevenueCat SDK integrated (`@revenuecat/purchases-capacitor`)
- [x] Live on a store: production release of build 7 ("1.1.1 Guestimator") set up; goes live after Google review
- [x] Public repo: https://github.com/banksythequantLab/guestimator
- [ ] Video under 2 minutes, showing Guestimator, uploaded and linked
- [ ] Store URL confirmed showing Guestimator
- [x] First real eBay listings (Sep 27, two items)
- [ ] First real Play purchase, then update Accomplishments

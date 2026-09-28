# Guestimator — What's it worth?

Photograph something, tell the app what you know, and get an identification and a price from
**what comparable items are listed for on eBay right now**, with the listings shown so you can
check the number. Then let Guestimator write the eBay listing and publish it to **your own eBay
account** after you've reviewed every field.

- Web app: **https://app.theguestimator.com**
- Website: https://theguestimator.com
- Android: `ai.banksy.bottletree` on Google Play (renamed from Bottle Tree)
- Built by Banksy AI LLC. Entered in the **Nebius x NVIDIA Global AI Hackathon** (Best Apps and
  Agents track). The in-app purchases were built for the RevenueCat Shipaton 2026.

Guestimator was split out of [Bottle Tree](https://github.com/banksythequantLab/bottletree-appraiser),
a POS and inventory app for antique shops, on 2026-09-27. The point-of-sale lives on there; this
repo is estimates and eBay listing only.

## How it works

```
 phone (Capacitor shell / PWA) ── photos + description ──▶ Cloudflare Worker ──▶ R2 photos · D1 items
                                                              │  (queue: one estimate per invocation)
                                                              ▼
         Gemma 3 27B reads each photo ──▶ evidence sheet ──▶ NVIDIA Nemotron 3 Super (Nebius Token Factory)
                                                              │   identify · price · draft listing
                                         eBay Browse API ─────┤   live asking prices, relevance-filtered
                                         Tavily (backfill) ───┘
                                                              ▼
                     estimate card ──▶ "List it on eBay" ──▶ draft: Taxonomy category + item specifics,
                                                              Metadata conditions, price from comps
                                                              ▼  user reviews every field, taps List
                                   Sell Inventory API on the USER's account: inventory item → offer → publish
```

- **Estimates.** Per-photo vision, then Nemotron over one evidence sheet. The owner's own words
  outrank the model's guess. It gets re-priced against live eBay comparables, with melt value as a
  floor for silver and gold, and asks a question instead of guessing when two readings are plausible.
- **Listing.** OAuth authorization-code grant with the app's RuName. Refresh tokens are sealed with
  AES-GCM. Categories come from Taxonomy suggestions; aspects are restricted to eBay's allowed
  values, with Brand taken from the appraiser's maker (never invented); condition comes only from
  that category's own list (some categories take none). If the seller has no business policies,
  Guestimator creates payment, 30-day return and flat-rate shipping policies.
- **Money.** RevenueCat (`@revenuecat/purchases-capacitor` on Android, a Web Purchase Link on the
  web) feeds a credits-and-plans ledger in D1. Consuming an estimate is atomic (unlimited, then plan
  cap, then credits, then a 402 paywall). A failed estimate or a listing eBay rejects is refunded
  automatically. The webhook is idempotent on event id and reads refunds from CANCELLATION's
  cancel_reason, since RevenueCat has no REFUND event.
- **Compliance.** eBay marketplace account-deletion endpoint (challenge plus notice handling, which
  deletes stored eBay data), privacy policy at https://theguestimator.com/privacy.

## NVIDIA Nemotron on Nebius Token Factory

Every estimate runs on **Nebius Token Factory**, called straight from the Cloudflare Worker through
its OpenAI-compatible endpoint (`https://api.tokenfactory.nebius.com/v1/`, see `worker/appraiser.js`).
There is no GPU server of our own to keep running.

| Model on Token Factory | Job |
| --- | --- |
| `nvidia/nemotron-3-super-120b-a12b` | The reasoning. It identifies the item from one evidence sheet, reads whether it is silver or gold, prices it, re-prices it against the live eBay listings it keeps (and says which it set aside and why), and fills eBay item specifics when the user lists it (`worker/ebay.js`). |
| `google/gemma-3-27b-it` | Vision: reads each photo on its own, including labels, marks and part numbers. |
| `Qwen/Qwen2.5-VL-72B-Instruct` | Vision fallback if Gemma fails on a photo. |

How the calls are shaped:

- **One evidence sheet, not a chat.** Each photo is read separately, then Nemotron gets one sheet
  with the photo reads, the owner's own notes (which outrank the model's guess) and the live eBay
  listings. It returns JSON: identification, confidence, price, and the listings it rejected.
- **Nemotron 3 Super is a reasoning model.** Its thinking shares the completion budget with the
  answer, so every call asks for at least 6,000 tokens (`textJson`). A smaller budget can be used up
  by the thinking before any answer is written.
- **JSON mode first, then plain.** Calls use `response_format: json_object`. If that is refused, the
  same request goes again without it and the JSON is extracted from the text.
- **Never trust a blank.** One re-price came back as the model's own empty template, all zeros. The
  Worker now checks that a price is actually usable and warns instead of showing $0.
- Models are set by environment variable (`TEXT_MODEL`, `VISION_MODEL`), so swapping one is a
  config change, not a code change.

Built during the hackathon: the first commit in this history (as Bottle Tree's appraiser) is
2026-09-16. Guestimator was split out, with eBay listing and credits added, on 2026-09-27.

## Repo layout

| Path | What |
| --- | --- |
| `worker/worker.js` | API: auth (password + Google), items, photos, estimates queue, eBay routes, RevenueCat webhook |
| `worker/appraiser.js` | The estimate pipeline: vision, evidence sheet, Nemotron, eBay/Tavily comps, re-pricing |
| `worker/ebay.js` | eBay OAuth, token sealing, taxonomy/aspects/conditions, policies, inventory → offer → publish |
| `worker/billing.js` | Credits, plans, RevenueCat event handling |
| `worker/public/` | The web app (single-page, no framework) and privacy policy |
| `worker/migrations/` | D1 schema (shared with Bottle Tree; Guestimator adds `ebay_*` tables in `0012`) |
| `worker/tests/` | 18 test files, 664 checks: `node worker/tests/run.mjs` |
| `android-app/` | Capacitor 8 shell loading the live web app, with RevenueCat and native Google sign-in |

## Running it

```
cd worker
npm i -g wrangler
node tests/run.mjs          # no network needed: eBay and the models are stubbed where it matters
npx wrangler deploy         # needs your own Cloudflare account, D1, R2, queue and the secrets below
```

Secrets (`wrangler secret put`): `NEBIUS_API_KEY`, `TAVILY_API_KEY`, `EBAY_CLIENT_ID`,
`EBAY_CLIENT_SECRET`, `EBAY_RUNAME`, `EBAY_TOKEN_KEY` (32 random bytes, base64), `EBAY_VERIFY_TOKEN`.
None are in this repo.

## Honest limits

Estimates are AI opinions from photos and notes, not appraisals. Comparables are **asking**
prices, not sold prices, so they run high; the app says so on every card. Guestimator is not
affiliated with or endorsed by eBay.

## License

See [LICENSE](LICENSE).

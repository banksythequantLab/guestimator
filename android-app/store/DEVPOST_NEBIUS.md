# Guestimator: Nebius x NVIDIA Global AI Hackathon entry

Paste-ready. Deadline **Oct 30, 2026, 1:00 pm EDT**. Track: **Best Apps and Agents**.
Lines marked **DEREK** are his to confirm or write.

| Field | Value |
| --- | --- |
| Project name | Guestimator: What's It Worth? |
| Tagline | Snap it, get a price from live eBay listings, and list it on your own eBay account. Nemotron on Nebius does the thinking. |
| Track | Best Apps and Agents |
| Demo URL | https://app.theguestimator.com (judges: sign up, tap the credits pill, enter **10FREECREDITS** for 10 free credits) |
| Video (public, <=3 min) | https://youtu.be/VzwvTy-FEuo (2:29) |
| Repo (MIT) | https://github.com/banksythequantLab/guestimator |
| Built with | nvidia-nemotron · nebius-token-factory · gemma · qwen · cloudflare-workers · cloudflare-d1 · cloudflare-r2 · cloudflare-queues · ebay-api · tavily · revenuecat · capacitor · javascript |
| IRL Builders & Brews city | **DEREK** (none, unless you attended one) |

## Inspiration

Everyone who has cleared out a garage or a relative's house asks the same question: what is
this worth? Answering it takes an hour of searching listings and squinting at maker's marks, and
then you still have to write the eBay listing. We wanted to photograph the thing and be done.

## What it does

Photograph an item from a few angles and type what you know. Guestimator identifies it and prices
it from what comparable items are listed for on eBay right now, and shows those listings so you
can check the number. It shows what it read off the label and which listings it set aside, and
why. When two identifications are plausible it asks you instead of guessing.

Then one tap writes the eBay listing: category from eBay's taxonomy, item specifics restricted to
eBay's allowed values, only conditions that category accepts, photos, description and a price
from the comparables. You review every field, and it publishes to **your own** eBay account.
Two real listings were made this way on Sep 27, 2026 (eBay items 198671504189 and 198671529701).

## How we built it: NVIDIA Nemotron on Nebius Token Factory

Every estimate runs on Nebius Token Factory, called straight from a Cloudflare Worker through its
OpenAI-compatible endpoint. There is no GPU server of our own.

- **Gemma 3 27B** (Qwen2.5-VL-72B as fallback) reads each photo on its own: labels, marks, part numbers.
- **NVIDIA Nemotron 3 Super** (`nvidia/nemotron-3-super-120b-a12b`) does the reasoning. It gets
  one evidence sheet (the photo reads, the owner's notes, which outrank the model, and the live
  eBay listings) and returns JSON: what the item is, how sure it is, the price, and which listings
  don't match. It also checks for silver and gold (melt value becomes a floor), re-prices against
  the listings it kept, and fills eBay item specifics when the user lists.
- A Cloudflare Queue runs one estimate per invocation; D1 holds items and a credits ledger; R2 holds photos.
- Live comparables come from the eBay Browse API, with Tavily as backfill.
- Listings go through eBay's Sell Inventory, Taxonomy, Metadata and Account APIs on the user's own
  account (OAuth, refresh tokens sealed with AES-GCM).
- 664 automated checks, with eBay and the models stubbed at the network layer.

## Challenges we ran into

**Reasoning tokens.** Nemotron 3 Super thinks inside the same completion budget as its answer, so
a small `max_tokens` can be used up before any JSON appears. Every call now asks for at least 6,000.

**The empty price.** One re-price came back as the model's own blank template, all zeros, and a
truthiness check accepted it. The Worker now tests that a price is actually usable and warns
instead of ever showing a silent $0.

**eBay categories are not uniform.** Some categories take no condition at all; sending one fails
at publish time. Conditions now come from each category's own list.

## Accomplishments we're proud of

Real prices on real objects: an 1878-patent cast-iron fluting iron identified as Shepard Hardware
Co. of Buffalo ($120-250), server memory priced from four live eBay listings, and two real eBay
listings published through the app.

## What we learned

Give the reasoning model one well-built evidence sheet instead of a conversation, let the owner's
own words outrank the model, and make it say which evidence it threw out. That is what makes the
number checkable.

## What's next

Sold-price history alongside asking prices, Etsy and Facebook Marketplace crosslisting, and iOS.

## Was the project started before the submission period?

The submission period opened Aug 26, 2026. The first commit (as the Bottle Tree appraiser) is
Sep 16, 2026, so all of it was built during the period. Guestimator was split out on Sep 27 with
eBay listing and credits added.

## Feedback on Nebius Token Factory and NVIDIA models (DEREK: edit to your own words)

- The OpenAI-compatible endpoint meant the Worker needed no SDK: plain `fetch` from Cloudflare.
- Nemotron 3 Super's reasoning is strong on messy evidence, but because thinking shares the
  completion budget, the docs could say plainly how many tokens to reserve.
- Image generation was not available on our account, so we could not use it for app art.

# eBay Listing API (item drafts) — access request

Send via the eBay Developers Program support page (signed in as the account that owns the app):
https://developer.ebay.com/my/support/tickets  → new ticket → category "API access / Limited Release"
(or whatever eBay's form calls it). Paste the text below.

---

**Subject:** Request for Sell Listing API access (sell.item.draft / createItemDraft), Guestimator

Hello eBay Developer Support,

We'd like to request access to the Sell Listing API (`createItemDraft`, scope
`https://api.ebay.com/oauth/api_scope/sell.item.draft`) for our production application.

**Application**
- App ID (production): DerekSol-BottleTr-PRD-5c897e253-2a5e84da
- RuName: Derek_Soltis-DerekSol-Bottle-mgcdka
- Company: Banksy AI LLC (contact: Derek Soltis, dj@soltis.info)
- Product: Guestimator, https://theguestimator.com (web: https://app.theguestimator.com;
  Android: Google Play package ai.banksy.bottletree)

**What Guestimator does**
Guestimator helps casual and small sellers (people clearing out a house, garage- and estate-sale
buyers, small antique dealers) work out what an item is worth and get it onto eBay. The user
photographs the item. We identify it and price it from current eBay listings (Browse API), then
pre-fill a listing: an eBay category from the Taxonomy API, item specifics restricted to the
category's allowed values, a condition valid for that category (Metadata API), photos, a
description and a price.

**Why the Listing API**
Today we use the Inventory API: we save the item and an unpublished offer, show the seller eBay's
own fee quote (`getListingFees`), and publish only when they confirm. Our sellers have told us
they would rather finish and submit the listing **on eBay's own listing page**. They want to see
exactly what eBay shows, adjust eBay-specific options (promotions, shipping services, returns) and
confirm fees in eBay's flow before anything goes live. `createItemDraft` with its redirect to
eBay's listing flow does exactly this: it keeps the seller in eBay's experience for the final,
money-spending step, and it brings eBay new, well-described first-time listings from people who
would otherwise not list at all.

**How we use eBay data and meet requirements**
- Users connect their own eBay account via OAuth (authorization code grant). Tokens are stored
  AES-GCM-encrypted and are used only for listings the user reviews and approves.
- The Marketplace Account Deletion endpoint is implemented and verified:
  https://app.theguestimator.com/api/ebay/deletion
- Privacy policy: https://theguestimator.com/privacy
- We never list without explicit user approval, and we never read users' messages, orders or payouts.

**Expected volume**
We're newly launched; initially low hundreds of drafts per month, growing with the app.

Thank you. We're happy to provide a demo account, screenshots or a walkthrough video.

Derek Soltis
Banksy AI LLC

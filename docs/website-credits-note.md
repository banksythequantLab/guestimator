# Note for the website AI: pricing is now "credits"

Guestimator now sells **credits**. One credit pays for one estimate OR one eBay listing, from the same balance. The app went live with this wording on Sep 27, 2026. The prices have not changed. Please update theguestimator.com to match.

## What is true now
- 1 credit = 1 estimate or 1 eBay listing.
- $0.99 = 1 credit. $4.99 = 10 credits (they never expire).
- Pro $9.99/month = 300 credits a month, split any way between estimates and eBay listings.
- Unlimited $29.99/month = no cap on estimates or listings.
- Previewing an eBay listing and eBay's fee quote is free. A listing that eBay rejects gets its credit back automatically.
- Creating an account is free. New accounts start with 0 credits (there is no free estimate).

## Edits in D:\theguestimator-site\public\index.html
- Line 249: "Estimates start at $0.99." becomes "Credits start at $0.99."
- Line 357 heading: "Pay per estimate, or go monthly" becomes "Pay as you go, or go monthly"
- Line 358: "Every estimate uses a credit or a monthly plan, bought in the app." becomes "One credit = one estimate or one eBay listing. Buy credits or a monthly plan in the app."
- Line 364: "Or $0.99 for a single estimate." becomes "Or $0.99 for a single credit." Keep the rest of the line.
- Line 369: "300 estimates a month, for resellers..." becomes "300 credits a month, split any way between estimates and eBay listings, for resellers and dealers pricing items every week."
- Line 378 is already correct (an eBay listing uses 1 credit, refunded if rejected). Keep it.

## Edits in D:\theguestimator-site\DEPLOY.md
- Line 28 is WRONG. It says "eBay listings free, no credit". Replace it with: "Pricing: 1 credit = 1 estimate or 1 eBay listing. $0.99 for 1, $4.99 for 10, $9.99/mo for 300, $29.99/mo unlimited. Listing previews are free; rejected listings are refunded."

## Edits in D:\theguestimator-site\public\privacy.html
- Line 70: "if you buy estimates or a subscription" becomes "if you buy credits or a subscription"
- Line 96: "and estimate credits" becomes "and credits"
- Leave the "Estimates are not appraisals" section as it is. It is about the AI estimate itself, not billing.

## Do not change
- Prices.
- Anything about Google Play product names. Derek may rename them in Play Console himself.

## Check when done
After deploying, fetch https://theguestimator.com/ and confirm that "per estimate" and "300 estimates" no longer appear anywhere on the page.

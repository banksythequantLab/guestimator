# Guestimator demo voice-over (Shipaton)

One line per scene. Each line is generated separately in Derek's cloned voice (FreeClone / VoxCPM2 on Johnson), and each scene in the video is held at least as long as its line. Numbers are written the way they should be spoken.

| # | Scene on screen | Voice-over |
|---|---|---|
| 1 | Title card | This is Guestimator. Snap it, price it, and list it on eBay. |
| 2 | Home screen | Most people have things worth selling and no idea what they're worth. Guestimator prices anything from a photo, using what's listed on eBay right now. |
| 3 | Taking the photos | I photograph the item and its label. Here, a server memory stick. Then one line about what I know. |
| 4 | Appraising | Behind the scenes, a Cloudflare Worker queues the job. Gemma 3 on Nebius reads the photos and the label. Nvidia's Nemotron identifies the item, and eBay's Browse API pulls every matching listing live right now. |
| 5 | The price | The answer: one sixty-six to one ninety-nine, suggested one seventy-seven, and ninety-five percent sure. |
| 6 | Comparables | Every number is backed by real listings I can tap and check. |
| 7 | Why / set aside | It also shows what it read off the label, and which listings it threw out, and why. |
| 8 | Tap List it on eBay | Want to sell it? One tap writes the eBay listing. |
| 9 | The listing form | The category comes from eBay's taxonomy, the item specifics use eBay's allowed values, and it only offers conditions that category accepts. |
| 10 | Fixing the part number | Everything is editable. The AI misread one character of the part number, so I fix it before anything goes to eBay. |
| 11 | Shipping, Preview | I set shipping, and preview. |
| 12 | Ready to list | It's saved on my own eBay account, but not live. |
| 13 | eBay's fee quote | Before I spend a cent, eBay itself quotes the fees. Today, thirty-five cents, waived. |
| 14 | List it now | One more tap and it's live. Listing uses one Guestimator credit, and it's refunded if eBay rejects it. |
| 15 | Credits card | Credits run through RevenueCat and Google Play. One credit is one estimate or one eBay listing. Pro is three hundred a month, split any way you like. |
| 16 | How it works card | Under the hood: a Capacitor Android app, a Cloudflare Worker with D1, R2 and Queues, Nebius for vision and reasoning, and eBay's Browse, Taxonomy, Inventory and Account APIs. |
| 17 | End card | Guestimator. Point, price, list. At theguestimator dot com, and on Google Play. |

Facts checked against the code (worker/appraiser.js, worker/ebay.js, worker/billing.js) and the real run on Sep 27, 2026: vision model google/gemma-3-27b-it, text model nvidia/nemotron-3-super-120b-a12b, comparables from the eBay Browse API item_summary search, $166 to $199 with $177 suggested at 95%, eBay insertion fee $0.35 with a $0.35 promotion.

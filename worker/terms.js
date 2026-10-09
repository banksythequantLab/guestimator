// Guestimator Market terms (2026-10-07). The text is Derek's to finalise: until MARKET_TERMS_LIVE
// is "on", /market-terms shows only to the owner, marked DRAFT, and nobody is asked to agree.
// Once it's on: every Market page links the terms, and the first time a seller lists an item they
// must agree (users.market_terms_at records when, and TERMS_VERSION which text).

import { page, esc } from "./garage.js";

// 2026-10-08: checked against NY case law in Lex (affirmative assent - Wu v. Uber (N.Y. 2024),
// Brooks v. Lang Yang (App. Div. 2023); no exculpation of gross negligence - Sear-Brown,
// Abramowitz; class waiver - Tsadilas (App. Div. 2004); changes on notice - Kinkopf). Buyers now
// tick a box at checkout too, and a new version asks sellers to agree again.
export const TERMS_VERSION = "2026-10-08";
// Owner check-in (Derek, 2026-10-08): revisit sales tax once yearly Market sales reach this.
export const MARKET_TAX_CHECK_CENTS = 5000000;
export const termsLive = env => String(env.MARKET_TERMS_LIVE || "").toLowerCase() === "on";

// Plain text, one item per entry. [Brackets] are open decisions for Derek and must be resolved
// before MARKET_TERMS_LIVE is switched on (termsReady says whether any are left).
export const TERMS = [
  ["What the Market is", "The Guestimator Market is run by Banksy AI LLC (\"Guestimator\", \"we\"). It lets people who use Guestimator list their own items for sale and lets anyone buy them. Guestimator is a venue only. We are not the seller, we do not own or inspect the items, and we are not a party to any sale."],
  ["No cut", "Guestimator charges no listing fee and takes no commission. Sellers pay only Stripe's card processing fee, which Stripe takes from their own account."],
  ["How payment works", "Buyers pay the seller directly through the seller's own Stripe account. The receipt is in the seller's name. Guestimator never holds buyers' money."],
  ["Sellers' promises", "A seller promises they own the item and may sell it; that the photos, title, description and condition are accurate; and that they will ship within the time stated, or arrange pickup, after payment."],
  ["Prices and estimates", "Guestimator estimates are market estimates from public listings, not appraisals or guarantees of value. The seller sets the price and is responsible for it."],
  ["Items you can't list", "Weapons and ammunition; drugs and drug paraphernalia; alcohol and tobacco; live animals; recalled or unsafe goods; counterfeit or stolen goods; ivory and other protected wildlife products; human remains; hazardous materials; anything illegal to sell or ship where the seller or buyer is. We may remove any listing at any time."],
  ["Returns, refunds and disputes", "Each shop states its returns policy on its item pages. Returns, refunds and disputes are between the buyer and the seller. Card disputes go through Stripe and the buyer's bank."],
  ["Taxes", "Sellers are responsible for their own income tax and any sales tax they owe."],
  ["Shipping and risk", "The seller chooses how to ship and is responsible for the item until it is delivered. Shipping labels bought through Guestimator are sold at cost."],
  ["Messages", "\"Ask the seller\" sends the buyer's question and email address to the seller. Don't use it for spam, harassment or to take a sale off the Market to avoid these terms."],
  ["No warranties; limits", "The Market is provided as is and as available, without warranties of any kind. To the fullest extent the law allows, Guestimator is not liable for the items, the sale, or what buyers and sellers do, and is not liable for any indirect, incidental, special, consequential or punitive damages. Our total liability to you for any claim is limited to the greater of $100 or what you paid Guestimator in the 12 months before the claim. None of this limits our liability for our own gross negligence, willful misconduct or fraud."],
  ["Disputes with us", "These terms are governed by the laws of the State of New Jersey, without regard to its conflict-of-law rules, and by the Federal Arbitration Act. Any dispute between you and Guestimator will be resolved by binding individual arbitration administered by the American Arbitration Association under its Consumer Arbitration Rules, instead of in court. This means you and Guestimator each give up the right to sue the other in court and to have a judge or jury decide the claim, except that either of us may bring an individual claim in small-claims court. You and Guestimator also each give up the right to bring or take part in a class or representative action. You can opt out of arbitration within 30 days of first agreeing to these terms by sending a message through Guestimator's Feedback page that says you opt out of arbitration. Disputes between buyers and sellers are not covered by this section."],
  ["How you agree", "Sellers agree by ticking the box the first time they list an item on the Market. Buyers agree by ticking the box before they pay. We keep a record of which version you agreed to and when."],
  ["Changes", "We may update these terms. The new version is posted here with its date, and sellers are asked to agree to it before their next listing. Buyers agree to the version shown when they pay. A change never applies to a dispute that started before it."],
];
export const termsReady = () => !TERMS.some(([, t]) => /\[[^\]]+\]/.test(t));

export function termsPage(env, { owner = false } = {}) {
  const live = termsLive(env);
  const items = TERMS.map(([h, t], i) => `<h3 style="font:700 1.05rem system-ui;margin:20px 0 4px">${i + 1}. ${esc(h)}</h3><p style="margin:0">${esc(t).replace(/\[([^\]]+)\]/g, '<mark style="background:#fbeae3">[$1]</mark>')}</p>`).join("");
  const banner = live ? "" : `<div class="note"><b>DRAFT, not in effect.</b> Only you (the owner) can see this page. Resolve the highlighted items, then set MARKET_TERMS_LIVE to "on".${termsReady() ? "" : " Open items remain."}</div>`;
  return page({ title: "Guestimator Market terms", desc: "The rules for buying and selling on the Guestimator Market. Guestimator takes no cut.",
    body: `<header><div class="wrap"><div class="kind">Guestimator</div><h1><a href="/market">Guestimator Market terms</a></h1><div class="when">Version ${esc(TERMS_VERSION)}</div></div></header>
<div class="wrap" style="max-width:760px">${banner}${items}<p class="muted" style="margin-top:28px"><a href="/market">Back to the Market</a></p></div>` });
}

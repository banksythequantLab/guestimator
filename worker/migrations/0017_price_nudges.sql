-- Price-drop nudges for eBay listings that have sat unsold. A listing is "slow" 14 days after it
-- went up or was last repriced (updated_at). The seller is emailed at most once per 14 days per
-- listing, and "Keep the price" hides the nudge for another 14 days.
ALTER TABLE ebay_listings ADD COLUMN nudge_emailed_at TEXT;
ALTER TABLE ebay_listings ADD COLUMN nudge_dismissed_at TEXT;

-- Last sold-price evidence seen for a listing (price check / nudges), so the slow-seller view
-- can suggest a market price without a lookup on every visit.
ALTER TABLE ebay_listings ADD COLUMN sold_count INTEGER;
ALTER TABLE ebay_listings ADD COLUMN sold_median_cents INTEGER;
ALTER TABLE ebay_listings ADD COLUMN sold_checked_at TEXT;

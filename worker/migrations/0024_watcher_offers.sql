-- Last discount sent to a listing's interested buyers (eBay Negotiation API).
ALTER TABLE ebay_listings ADD COLUMN watch_offer_at TEXT;
ALTER TABLE ebay_listings ADD COLUMN watch_offer_pct INTEGER;

-- Best Offer thresholds we set on the eBay listing (NULL = offers off).
ALTER TABLE ebay_listings ADD COLUMN best_offer_accept_cents INTEGER;
ALTER TABLE ebay_listings ADD COLUMN best_offer_decline_cents INTEGER;

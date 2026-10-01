-- The lowest offer the seller wants to see for a listing (cents). Set, it replaces the 70% / estimate-floor
-- auto-decline line, and survives price drops.
ALTER TABLE ebay_listings ADD COLUMN best_offer_min_cents INTEGER;

-- Seller's switch: keep this item off the public price guide (/price/...).
ALTER TABLE items ADD COLUMN guide_hidden INTEGER;

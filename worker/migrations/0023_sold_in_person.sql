-- Sold in person outside a sale page (scanned the item's sticker, tapped Sold): price and when.
ALTER TABLE item_finance ADD COLUMN sold_cents INTEGER;
ALTER TABLE item_finance ADD COLUMN sold_at TEXT;

-- Profit tracking. What the seller paid for an item lives here, not on `items`, which is shared
-- with Bottle Tree. eBay's fees and the shipping the buyer paid are kept on each eBay order so
-- profit can be worked out without asking eBay again.
CREATE TABLE IF NOT EXISTS item_finance (
  item_id     TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  cost_cents  INTEGER,            -- what the seller paid for it (null = not entered)
  note        TEXT,               -- where it came from, e.g. "Elm St estate sale"
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS item_finance_user ON item_finance(user_id);

ALTER TABLE ebay_orders ADD COLUMN fee_cents INTEGER;        -- eBay's totalMarketplaceFee
ALTER TABLE ebay_orders ADD COLUMN ship_paid_cents INTEGER;  -- pricingSummary.deliveryCost

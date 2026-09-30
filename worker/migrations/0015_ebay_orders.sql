-- eBay sales of items listed through Guestimator. Read from the Sell Fulfillment API (getOrders)
-- on a schedule and when the seller opens the app; one row per order line that is ours (SKU
-- GUESS-...). The buyer's address is kept only while the order is open - it is what goes on the
-- packing slip and the label - and is cleared once the order is shipped.
CREATE TABLE IF NOT EXISTS ebay_orders (
  id            TEXT PRIMARY KEY,            -- orderId:lineItemId
  order_id      TEXT NOT NULL,
  line_item_id  TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  listing_id    TEXT,
  title         TEXT,
  quantity      INTEGER NOT NULL DEFAULT 1,
  buyer         TEXT,                        -- eBay username
  total_cents   INTEGER,                     -- what the buyer paid for the whole order
  ship_to       TEXT,                        -- JSON {name, phone, address:{line1,...}} (shipToLines shape)
  ship_service  TEXT,
  ship_by       TEXT,                        -- eBay's "ship by" date
  status        TEXT NOT NULL,               -- NOT_STARTED | IN_PROGRESS | FULFILLED | CANCELLED
  tracking      TEXT,
  ordered_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ebay_orders_user ON ebay_orders(user_id, status, ordered_at);

-- When orders were last read for this account, and whether its consent covers the Fulfillment
-- API (accounts connected before sale alerts existed have to reconnect once: 0 = needs it).
ALTER TABLE ebay_accounts ADD COLUMN orders_synced_at TEXT;
ALTER TABLE ebay_accounts ADD COLUMN fulfillment_ok INTEGER;

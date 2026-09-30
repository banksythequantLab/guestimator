-- Shipping labels bought through Shippo for an online order (garage-sale or eBay). Labels are
-- charged to the Shippo account behind SHIPPO_API_TOKEN, so buying is switched on per account
-- (LABEL_USERS). One label per order: a second buy for the same order is refused.
CREATE TABLE IF NOT EXISTS shipping_labels (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  kind            TEXT NOT NULL,        -- garage | ebay
  order_id        TEXT NOT NULL,        -- garage_orders.id or ebay_orders.id
  transaction_id  TEXT NOT NULL,        -- Shippo transaction object_id (needed to void/refund)
  rate_id         TEXT,
  carrier         TEXT,
  service         TEXT,
  amount_cents    INTEGER,
  tracking        TEXT,
  label_url       TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (kind, order_id)
);

-- The seller's return address, printed as the label's "from". Kept apart from `users`, which is
-- shared with Bottle Tree.
CREATE TABLE IF NOT EXISTS seller_settings (
  user_id     TEXT PRIMARY KEY,
  ship_from   TEXT,                     -- JSON {name, street1, street2, city, state, zip, phone}
  updated_at  TEXT NOT NULL
);

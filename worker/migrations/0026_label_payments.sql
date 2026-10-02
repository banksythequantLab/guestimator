-- Sellers pay for a label by card (Stripe, on the platform account) before Guestimator buys it on
-- the house Shippo account. One row per checkout; refunded if the label can't be bought.
CREATE TABLE IF NOT EXISTS label_payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  order_id TEXT NOT NULL,
  rate_id TEXT NOT NULL,
  file_type TEXT,
  label_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  processing_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  session_id TEXT,
  payment_intent TEXT,
  status TEXT NOT NULL,          -- pending | buying | bought | refunded | expired | stuck
  error TEXT,
  label_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS label_payments_order ON label_payments(kind, order_id);
-- Who paid Shippo for a label: NULL/'house' = house account, 'paid' = house account paid by the
-- seller through Stripe, 'seller' = the seller's own Shippo account. Counts toward the house cap
-- unless 'seller'.
ALTER TABLE shipping_labels ADD COLUMN payer TEXT;

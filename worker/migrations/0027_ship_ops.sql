-- Shipping ops: void a label, USPS pickup, ship-by reminders, money-safety alerts.

-- Voiding: the voided label's order_id is moved to "<order>~void~<label id>" so the order can get
-- a new label (UNIQUE(kind, order_id)); the real order is kept in void_of.
ALTER TABLE shipping_labels ADD COLUMN void_of TEXT;
ALTER TABLE shipping_labels ADD COLUMN void_refund_id TEXT;       -- Shippo refund object_id
ALTER TABLE shipping_labels ADD COLUMN void_status TEXT;          -- QUEUED | PENDING | SUCCESS | ERROR
ALTER TABLE shipping_labels ADD COLUMN voided_at TEXT;
ALTER TABLE shipping_labels ADD COLUMN card_refund_id TEXT;       -- Stripe refund once Shippo refunds a card-paid label
-- USPS carrier pickup booked for this label (JSON: confirmation, window, status).
ALTER TABLE shipping_labels ADD COLUMN pickup TEXT;

-- Label payments that went wrong: alerted to the house once.
ALTER TABLE label_payments ADD COLUMN alerted_at TEXT;

-- Ship-by reminder sent (once per order).
ALTER TABLE ebay_orders ADD COLUMN ship_reminded_at TEXT;
ALTER TABLE garage_orders ADD COLUMN ship_reminded_at TEXT;

-- One-off flags so an alert goes out once (e.g. "cap-warn-2026-10").
CREATE TABLE IF NOT EXISTS ops_flags (
  key TEXT PRIMARY KEY,
  at  TEXT NOT NULL
);

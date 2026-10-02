-- eBay after-sale care: returns, item-not-received inquiries and cases on items listed through
-- Guestimator, so the seller is emailed once when one opens and again when it needs them.
CREATE TABLE IF NOT EXISTS ebay_disputes (
  id          TEXT PRIMARY KEY,           -- kind:ext_id
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- return | inquiry | case
  ext_id      TEXT NOT NULL,
  order_id    TEXT,
  item_id     TEXT,                       -- eBay listing id
  state       TEXT,
  reason      TEXT,
  buyer       TEXT,
  respond_by  TEXT,
  alerted_state TEXT,                     -- the state we last emailed about
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ebay_disputes_user ON ebay_disputes(user_id, updated_at);
ALTER TABLE ebay_accounts ADD COLUMN care_checked_at TEXT;
ALTER TABLE ebay_accounts ADD COLUMN care_error TEXT;
ALTER TABLE ebay_accounts ADD COLUMN messages_checked_at TEXT;
ALTER TABLE ebay_accounts ADD COLUMN messages_ok INTEGER;      -- 0 = token lacks commerce.message (reconnect)

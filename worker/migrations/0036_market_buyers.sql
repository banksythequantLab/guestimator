-- Guestimator Market, buyer side (2026-10-06).
-- returns: the seller's returns promise shown on their item pages. NULL = "ask the seller";
-- 'none' = no returns unless it isn't as described; '14' / '30' = days after delivery.
ALTER TABLE garage_sales ADD COLUMN returns TEXT;

-- "Message the seller" from a Market item page. Emailed to the seller (reply goes to the buyer's
-- email); kept here for rate limiting and so the seller can see them in the app later.
CREATE TABLE IF NOT EXISTS market_questions (
  id         TEXT PRIMARY KEY,
  sale_id    TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  message    TEXT NOT NULL,
  ip_hash    TEXT,
  emailed    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mq_sale ON market_questions(sale_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mq_ip ON market_questions(ip_hash, created_at);
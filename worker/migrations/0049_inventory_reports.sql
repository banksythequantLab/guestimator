-- Inventory reports (2026-11-19): a flat-priced, printable contents inventory with a market estimate
-- per item, for insurance claims, marital-property schedules and estate / probate inventories.
-- Paying for a report grants its item allowance as credits (billing_events source 'report'), so the
-- estimates run through the normal metered path and the report never has its own pricing logic.
CREATE TABLE IF NOT EXISTS inventory_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL,            -- insurance | divorce | estate | other
  tier TEXT NOT NULL,               -- small | medium | large
  items_cap INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | pending | paid | expired | refunded
  session_id TEXT,
  payment_intent TEXT,
  owner_name TEXT,                  -- as it should read on the report (an executor, a party, an insured)
  notes TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inventory_reports_user ON inventory_reports(user_id, created_at);
CREATE TABLE IF NOT EXISTS report_items (
  report_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (report_id, item_id)
);

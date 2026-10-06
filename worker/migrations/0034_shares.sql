-- Public share links for one finished estimate (2026-10-06). See share.js.
CREATE TABLE IF NOT EXISTS estimate_shares (
  token TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  appraisal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS estimate_shares_appraisal ON estimate_shares(appraisal_id, user_id);

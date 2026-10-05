-- Sellers rate how close an estimate was. A rating earns a free estimate credit (capped per
-- month), and the ratings are the accuracy record for the appraiser. One rating per estimate.
CREATE TABLE IF NOT EXISTS estimate_ratings (
  appraisal_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  stars INTEGER NOT NULL,          -- 1..5: how close the price was
  note TEXT,
  credited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS estimate_ratings_user ON estimate_ratings(user_id, created_at);

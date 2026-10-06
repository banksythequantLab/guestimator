-- Guestimator Market page views per day (owner page launch numbers). One row per UTC day.
CREATE TABLE IF NOT EXISTS market_views (
  day   TEXT PRIMARY KEY,   -- YYYY-MM-DD (UTC)
  views INTEGER NOT NULL DEFAULT 0
);

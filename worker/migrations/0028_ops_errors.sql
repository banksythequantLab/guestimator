-- Background job failures (the 15-minute cron), shown on the owner dashboard. Kept 30 days.
CREATE TABLE IF NOT EXISTS ops_errors (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  job     TEXT NOT NULL,
  message TEXT
);
CREATE INDEX IF NOT EXISTS ops_errors_at ON ops_errors(at);

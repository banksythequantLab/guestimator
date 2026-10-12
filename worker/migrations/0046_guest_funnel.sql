-- Try before sign-up (2026-10-12): guest starts, rate-limited per network and per day.
CREATE TABLE IF NOT EXISTS guest_starts (ip_hash TEXT, user_id TEXT, at TEXT);
CREATE INDEX IF NOT EXISTS guest_starts_at ON guest_starts(at);
-- Funnel: each tagged visit gets a session id; events after the landing are counted per session.
ALTER TABLE landing_hits ADD COLUMN ev TEXT;
ALTER TABLE landing_hits ADD COLUMN sid TEXT;

-- Arrivals from tagged links (ads, posts), counted whether or not the visitor signs up (2026-10-08).
CREATE TABLE IF NOT EXISTS landing_hits (src TEXT, camp TEXT, content TEXT, inapp INTEGER, at TEXT);
CREATE INDEX IF NOT EXISTS landing_hits_at ON landing_hits(at);

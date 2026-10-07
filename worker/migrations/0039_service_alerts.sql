CREATE TABLE IF NOT EXISTS service_alerts (service TEXT PRIMARY KEY, message TEXT, first_seen TEXT, last_seen TEXT, hits INTEGER DEFAULT 0, emailed_at TEXT);

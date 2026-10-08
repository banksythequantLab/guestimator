-- One owner's Monday report per ISO week (ownerweekly.js).
CREATE TABLE IF NOT EXISTS owner_reports (week TEXT PRIMARY KEY, sent_at TEXT NOT NULL);

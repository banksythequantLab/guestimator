-- When (and which version) a seller agreed to the Guestimator Market terms (terms.js).
ALTER TABLE users ADD COLUMN market_terms_at TEXT;
ALTER TABLE users ADD COLUMN market_terms_version TEXT;

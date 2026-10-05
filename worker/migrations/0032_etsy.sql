-- Etsy cross-listing: a vintage item listed on eBay can also go on the seller's own Etsy shop,
-- and whichever sells first takes it off the other. Additive only.

-- One linked Etsy shop per user. Tokens sealed with EBAY_TOKEN_KEY (AES-GCM), like eBay's.
CREATE TABLE IF NOT EXISTS etsy_accounts (
  user_id TEXT PRIMARY KEY,
  etsy_user_id TEXT,
  shop_id TEXT,
  shop_name TEXT,
  refresh_token_enc TEXT NOT NULL,
  access_token_enc TEXT,
  access_expires_at TEXT,
  readiness_state_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- PKCE round trip: the verifier stays here, never in the browser.
CREATE TABLE IF NOT EXISTS etsy_oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  verifier TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS etsy_listings (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,            -- publishing | active | ended | sold | error
  listing_id TEXT,
  listing_url TEXT,
  price_cents INTEGER,
  taxonomy_id INTEGER,
  when_made TEXT,
  funded_by TEXT,
  error TEXT,
  checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS etsy_listings_item ON etsy_listings(item_id, created_at);
CREATE INDEX IF NOT EXISTS etsy_listings_active ON etsy_listings(status, checked_at);

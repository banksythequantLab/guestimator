-- Guestimator: list an estimated item on the user's own eBay account.
-- Additive only. The D1 database is shared with Bottle Tree, which never reads these tables.

-- One linked eBay account per user. Tokens are AES-GCM sealed with EBAY_TOKEN_KEY; the refresh
-- token acts as the user on eBay for 18 months and never leaves the Worker in the clear.
CREATE TABLE IF NOT EXISTS ebay_accounts (
  user_id TEXT PRIMARY KEY,
  ebay_user_id TEXT,
  ebay_username TEXT,
  refresh_token_enc TEXT NOT NULL,
  refresh_expires_at TEXT,
  access_token_enc TEXT,
  access_expires_at TEXT,
  postal_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ebay_accounts_ebay_user ON ebay_accounts(ebay_user_id);

-- The OAuth `state` round trip. The callback lands in whatever browser eBay opened, which on a
-- phone is not the app, so the state row - not a cookie - is what says whose account this is.
CREATE TABLE IF NOT EXISTS ebay_oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Every attempt to list an item, kept: the draft the person reviewed, what was sent, and what
-- eBay answered. offer_id is kept so a retry updates the same offer instead of making another.
CREATE TABLE IF NOT EXISTS ebay_listings (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  status TEXT NOT NULL,            -- draft | published | error
  offer_id TEXT,
  listing_id TEXT,
  listing_url TEXT,
  category_id TEXT,
  price_cents INTEGER,
  draft_json TEXT,
  error TEXT,
  funded_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ebay_listings_item ON ebay_listings(item_id, created_at);

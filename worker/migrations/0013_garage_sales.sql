-- Garage, yard and estate sales run from Guestimator.
--
-- A seller makes a sale (free), adds items they have already guestimated, and gets a public page
-- at /sale/<slug>. Shoppers browse it, ask to hold an item, and - if the seller has connected
-- Stripe - buy remotely for pickup or shipping.
--
-- These are new tables rather than more columns on `sales`, because `sales` is shared with
-- Bottle Tree's point of sale and already means "a POS event with takings". An item can sit in a
-- Guestimator sale without leaving the seller's item list.

CREATE TABLE IF NOT EXISTS garage_sales (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'garage',     -- garage | yard | estate | moving
  title         TEXT NOT NULL,
  description   TEXT,
  street        TEXT,                               -- private until reveal day
  city          TEXT NOT NULL,
  state         TEXT NOT NULL,                      -- two-letter
  zip           TEXT,
  starts_on     TEXT NOT NULL,                      -- YYYY-MM-DD, seller's local date
  ends_on       TEXT NOT NULL,
  hours         TEXT,                               -- free text, e.g. "8am-2pm"
  tz            TEXT NOT NULL DEFAULT 'America/New_York',
  status        TEXT NOT NULL DEFAULT 'draft',      -- draft | published | ended
  pickup_ok     INTEGER NOT NULL DEFAULT 1,         -- remote buyers may collect in person
  ship_ok       INTEGER NOT NULL DEFAULT 0,         -- remote buyers may have items shipped
  online_ok     INTEGER NOT NULL DEFAULT 0,         -- Buy button shown (also needs Stripe ready)
  contact_phone TEXT,                               -- shown to people whose hold is accepted
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gsales_user ON garage_sales(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gsales_where ON garage_sales(status, state, city, starts_on);

-- One row per item on sale. price_cents is the tag price at the sale; online_price_cents is what
-- a remote buyer pays (NULL = same as the tag). ship_cents NULL means this item cannot be shipped.
CREATE TABLE IF NOT EXISTS garage_sale_items (
  sale_id            TEXT NOT NULL,
  item_id            TEXT NOT NULL,
  price_cents        INTEGER NOT NULL,
  online_price_cents INTEGER,
  ship_cents         INTEGER,
  status             TEXT NOT NULL DEFAULT 'available', -- available | held | pending | sold
  sort               INTEGER NOT NULL DEFAULT 0,
  sold_at            TEXT,
  added_at           TEXT NOT NULL,
  PRIMARY KEY (sale_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_gsitems_item ON garage_sale_items(item_id);

-- A shopper asking the seller to keep an item for them. No account needed; the seller calls or
-- texts back. The item shows "on hold" only once the seller accepts.
CREATE TABLE IF NOT EXISTS garage_holds (
  id         TEXT PRIMARY KEY,
  sale_id    TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  note       TEXT,
  status     TEXT NOT NULL DEFAULT 'new',          -- new | accepted | declined | done
  ip_hash    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gholds_sale ON garage_holds(sale_id, status, created_at);

-- Remote purchases through Stripe Connect (destination charges, platform fee).
CREATE TABLE IF NOT EXISTS garage_orders (
  id                TEXT PRIMARY KEY,
  sale_id           TEXT NOT NULL,
  item_id           TEXT NOT NULL,
  seller_account    TEXT NOT NULL,                 -- Stripe connected account paid
  stripe_session_id TEXT UNIQUE,
  payment_intent    TEXT,
  fulfilment        TEXT NOT NULL,                 -- pickup | ship
  item_cents        INTEGER NOT NULL,
  ship_cents        INTEGER NOT NULL DEFAULT 0,
  fee_cents         INTEGER NOT NULL DEFAULT 0,    -- platform fee kept by Guestimator
  total_cents       INTEGER NOT NULL,
  buyer_name        TEXT,
  buyer_email       TEXT,
  ship_address      TEXT,                          -- JSON from Checkout
  tracking          TEXT,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | paid | fulfilled | cancelled | refund_needed
  note              TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gorders_sale ON garage_orders(sale_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_gorders_item ON garage_orders(item_id, status);

-- users.stripe_account_id already exists (0011). Guestimator records whether that account can be
-- paid yet, refreshed from Stripe on return from onboarding and on account.updated.
ALTER TABLE users ADD COLUMN stripe_payouts_ready INTEGER NOT NULL DEFAULT 0;

-- Garage-sale payouts get their own column. users.stripe_account_id belongs to Bottle Tree's
-- storefront, where the only honoured value is the platform's OWN account (the platform owner's
-- shop). Reusing it here would have pointed destination charges at the platform itself, which
-- Stripe refuses, and creating a connected account over it would have switched off the owner's
-- Bottle Tree checkout. A Stripe Connect Express account for sales lives here instead.
ALTER TABLE users ADD COLUMN connect_account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_users_connect ON users(connect_account_id) WHERE connect_account_id IS NOT NULL;

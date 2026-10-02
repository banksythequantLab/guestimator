-- Growth: seller referral links, and win-back emails for Guestimator sign-ups.

-- One personal referral code per seller (app.theguestimator.com/?ref=CODE).
CREATE TABLE IF NOT EXISTS ref_codes (
  user_id    TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
-- Who brought whom. Rewarded (both sides) once the new seller makes a first real purchase.
CREATE TABLE IF NOT EXISTS referrals (
  referee_id  TEXT PRIMARY KEY,           -- the new account (one referrer per account, ever)
  referrer_id TEXT NOT NULL,
  code        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  rewarded_at TEXT
);
CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals(referrer_id, rewarded_at);

-- Guestimator's own accounts. `users` is shared with Bottle Tree, so marketing email only goes
-- to people in this table: everyone who signs up here from now on, plus existing accounts that
-- have used Guestimator (an estimate or a connected eBay account).
CREATE TABLE IF NOT EXISTS gs_users (
  user_id       TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  marketing_off INTEGER,                  -- 1 = unsubscribed from win-back emails
  winback1_at   TEXT,                     -- "price your first thing" (never estimated)
  winback2_at   TEXT                      -- "your items are waiting" (gone quiet)
);
-- Backfill. winback1_at is set so existing accounts never get the first-estimate nudge.
INSERT OR IGNORE INTO gs_users (user_id, created_at, winback1_at)
  SELECT DISTINCT s.user_id, u.created_at, u.created_at FROM appraisals a JOIN items i ON i.id=a.item_id JOIN sales s ON s.id=i.sale_id JOIN users u ON u.id=s.user_id;
INSERT OR IGNORE INTO gs_users (user_id, created_at, winback1_at)
  SELECT e.user_id, u.created_at, u.created_at FROM ebay_accounts e JOIN users u ON u.id=e.user_id;

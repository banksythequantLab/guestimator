-- Weekly selling summary: when it last went out, and whether the seller turned it off.
ALTER TABLE seller_settings ADD COLUMN weekly_sent_at TEXT;
ALTER TABLE seller_settings ADD COLUMN weekly_off INTEGER;

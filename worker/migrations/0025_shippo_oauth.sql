-- A seller's own Shippo account, connected by OAuth (labels billed by Shippo to them).
ALTER TABLE seller_settings ADD COLUMN shippo_token_enc TEXT;
ALTER TABLE seller_settings ADD COLUMN shippo_connected_at TEXT;

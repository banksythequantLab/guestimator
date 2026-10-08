-- Guestimator: when the 'your Guestimate is ready to sell' email went out (growth.js early nudge).
ALTER TABLE gs_users ADD COLUMN early_at TEXT;

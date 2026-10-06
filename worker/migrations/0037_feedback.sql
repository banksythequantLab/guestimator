-- In-app feedback (2026-10-06): ideas, problems and anything else, from signed-in users.
-- status is the owner's: new | planned | done | declined. owner_note is shown back to the sender.
CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,                 -- idea | bug | other
  message     TEXT NOT NULL,
  page        TEXT,                          -- the app screen it was sent from
  app_version TEXT,
  status      TEXT NOT NULL DEFAULT 'new',
  owner_note  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, created_at);
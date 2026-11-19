-- Spanish price pages (2026-11-19). A page's Spanish title lives here, set once by the owner's
-- translate sweep (model translation, reviewed); the English page's data is reused for everything
-- else. /es/price/<slug-from-title_es>-<id>. Pages without a row have no Spanish version.
CREATE TABLE IF NOT EXISTS guide_es (
  item_id TEXT PRIMARY KEY,
  title_es TEXT NOT NULL,
  category_es TEXT,
  created_at TEXT NOT NULL
);

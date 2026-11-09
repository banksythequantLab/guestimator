-- Price-guide title (2026-11-09). A page's title is also its URL slug, and ai_title is rewritten every
-- time the item is re-estimated (the 30-day refresh), so pages could change name and address each
-- month. guide_title is set once, when the item goes on the guide, and can be edited by hand.
ALTER TABLE items ADD COLUMN guide_title TEXT;

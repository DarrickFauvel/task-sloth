-- A where/how can have several spots on the map (every Target nearby), instead of one (012's place_* columns).
-- Spots set so far move over, then those columns go.
CREATE TABLE context_spots (
  id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL REFERENCES contexts(id),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  label TEXT,              -- the address picked from a search; empty for "I'm here now"
  created_at TEXT NOT NULL
);
CREATE INDEX context_spots_context ON context_spots(context_id);

INSERT INTO context_spots (id, context_id, lat, lng, label, created_at)
  SELECT lower(hex(randomblob(12))), id, place_lat, place_lng, place_label, created_at
    FROM contexts WHERE place_lat IS NOT NULL AND place_lng IS NOT NULL;

ALTER TABLE contexts DROP COLUMN place_lat;
ALTER TABLE contexts DROP COLUMN place_lng;
ALTER TABLE contexts DROP COLUMN place_label;

-- A where/how can be a real place (@Target): its spot on the map, set with "I'm here now" or an address search,
-- so the app can say when you're near it. Where/hows that aren't places (@phone) leave these empty.
ALTER TABLE contexts ADD COLUMN place_lat REAL;
ALTER TABLE contexts ADD COLUMN place_lng REAL;
ALTER TABLE contexts ADD COLUMN place_label TEXT; -- the address picked from a search; empty for "I'm here now"

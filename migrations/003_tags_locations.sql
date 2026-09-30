-- Places ("@Target" in quick add) and tags ("+errand"). Both are per household and reused by name.
CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX locations_name ON locations(household_id, name COLLATE NOCASE);

ALTER TABLE tasks ADD COLUMN location_id TEXT REFERENCES locations(id);
CREATE INDEX tasks_location ON tasks(location_id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,             -- lowercase, no spaces: "errand", "quick-win"
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX tags_name ON tags(household_id, name);

CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (task_id, tag_id)
);
CREATE INDEX task_tags_tag ON task_tags(tag_id);

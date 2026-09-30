-- Photos taken for a task. The image itself lives on Cloudinary; public_id finds it there.
CREATE TABLE task_photos (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  public_id TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX task_photos_task ON task_photos(task_id, created_at);

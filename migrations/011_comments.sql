-- Comments on the task page: deleting one is undoable from the toast (deleted_at), and each person's "last seen"
-- per task lets a task row mark comments someone else left since (the 💬 count gets a "new" dot).
ALTER TABLE comments ADD COLUMN deleted_at TEXT;

CREATE TABLE comment_reads (
  user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, task_id)
);

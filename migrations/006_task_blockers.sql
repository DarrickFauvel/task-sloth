-- A task can be blocked by another task ("paint the bedroom" after "patch the walls").
-- It stays on its list; marking the blocking task done (or deleting it) clears this.
ALTER TABLE tasks ADD COLUMN waiting_task_id TEXT REFERENCES tasks(id);
CREATE INDEX tasks_waiting_task ON tasks(waiting_task_id);

-- "Working on now": who is doing a task right this minute. One task per person at a time; it lapses at
-- working_until (the end of the day where they started it), so nothing looks stuck the next morning.
ALTER TABLE tasks ADD COLUMN working_by TEXT REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN working_since TEXT;
ALTER TABLE tasks ADD COLUMN working_until TEXT;
CREATE INDEX tasks_working_by ON tasks(working_by) WHERE working_by IS NOT NULL;

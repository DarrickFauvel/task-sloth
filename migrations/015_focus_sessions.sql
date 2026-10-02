-- Focus sessions: one person working through a project's or a where/how's tasks, one at a time.
-- One open session per person; it ends when they end it, start another, or at working_until-style `until`
-- (the end of the day where they started it).
CREATE TABLE focus_sessions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  project_id TEXT REFERENCES projects(id),   -- exactly one of project_id and context_id is set
  context_id TEXT REFERENCES contexts(id),
  skipped TEXT NOT NULL DEFAULT '[]',        -- task ids moved to the back, in the order they were skipped
  set_aside TEXT NOT NULL DEFAULT '[]',      -- "Not today": task ids left out of this session
  claimed TEXT NOT NULL DEFAULT '[]',        -- nobody's tasks the session made yours (handed back if set aside)
  started_at TEXT NOT NULL,
  until TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX focus_sessions_open ON focus_sessions(household_id) WHERE ended_at IS NULL;

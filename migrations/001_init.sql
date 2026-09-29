-- Task Sloth initial schema. All timestamps are ISO-8601 UTC strings; dates are YYYY-MM-DD.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  color TEXT NOT NULL DEFAULT '#6d5dfc',
  -- Google Tasks sync (tokens are encrypted at rest)
  google_refresh_token TEXT,
  google_access_token TEXT,
  google_token_expires_at TEXT,
  google_list_id TEXT,
  google_last_pull TEXT,
  google_sync_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,            -- sha256 of the cookie token
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE memberships (
  household_id TEXT NOT NULL REFERENCES households(id),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),  -- one household per user
  joined_at TEXT NOT NULL,
  PRIMARY KEY (household_id, user_id)
);

CREATE TABLE invites (
  token TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '📁',
  color TEXT NOT NULL DEFAULT '#6d5dfc',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX projects_household ON projects(household_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  due_date TEXT,                   -- YYYY-MM-DD
  due_time TEXT,                   -- HH:MM (app only; Google Tasks is date-only)
  priority INTEGER NOT NULL DEFAULT 0,   -- 0 normal, 1 high, -1 low
  status TEXT NOT NULL DEFAULT 'open',   -- open | done
  assignee_id TEXT REFERENCES users(id), -- NULL = up for grabs
  creator_id TEXT NOT NULL REFERENCES users(id),
  recurrence TEXT,                 -- JSON rule, see public/js/lib/recurrence.js
  next_task_id TEXT,               -- occurrence spawned when this recurring task was completed
  list_mode TEXT NOT NULL DEFAULT 'checklist', -- checklist | shopping
  is_template INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  completed_by TEXT REFERENCES users(id),
  deleted_at TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_household_status ON tasks(household_id, status, due_date);
CREATE INDEX tasks_assignee ON tasks(assignee_id);
CREATE INDEX tasks_project ON tasks(project_id);

CREATE TABLE checklist_items (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  text TEXT NOT NULL,
  quantity TEXT,
  category TEXT,
  checked INTEGER NOT NULL DEFAULT 0,
  checked_by TEXT REFERENCES users(id),
  sort_order REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX checklist_task ON checklist_items(task_id);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX comments_task ON comments(task_id);

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  actor_id TEXT REFERENCES users(id),   -- NULL when the change came from Google
  task_id TEXT REFERENCES tasks(id),
  verb TEXT NOT NULL,
  detail TEXT,                          -- JSON
  created_at TEXT NOT NULL
);
CREATE INDEX activity_household ON activity(household_id, created_at);

-- Which Google task mirrors which app task / checklist item, and in whose list.
CREATE TABLE google_links (
  entity_type TEXT NOT NULL,       -- task | item
  entity_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT NOT NULL,           -- the task itself, or the item's parent task
  google_task_id TEXT NOT NULL,
  google_updated TEXT,             -- Google's `updated` as of our last read/write
  synced_at TEXT NOT NULL,         -- when we last wrote or read it
  PRIMARY KEY (entity_type, entity_id)
);
CREATE UNIQUE INDEX google_links_remote ON google_links(user_id, google_task_id);
CREATE INDEX google_links_task ON google_links(task_id);

-- Tasks waiting to be pushed to Google.
CREATE TABLE sync_queue (
  task_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  enqueued_at TEXT NOT NULL
);

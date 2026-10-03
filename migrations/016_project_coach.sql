-- Project plans from Claude. A project started from a goal keeps the goal and what the person said about it;
-- check-ins (the first one is the plan) hold photos and Claude's reply; suggestions are steps and upkeep
-- tasks Claude proposed, until someone adds them as real tasks or dismisses them.
ALTER TABLE projects ADD COLUMN goal TEXT;
ALTER TABLE projects ADD COLUMN goal_notes TEXT;

CREATE TABLE project_checkins (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,                       -- start | checkin | upkeep
  note TEXT NOT NULL DEFAULT '',            -- what the person wrote
  status TEXT NOT NULL DEFAULT 'draft',     -- draft | thinking | ready | failed
  reply TEXT,                               -- Claude's answer (JSON), once ready
  error TEXT,                               -- why it failed, to show
  asked_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX project_checkins_project ON project_checkins(project_id, created_at);

-- Like task_photos: the image lives on Cloudinary.
CREATE TABLE checkin_photos (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  checkin_id TEXT NOT NULL REFERENCES project_checkins(id),
  public_id TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX checkin_photos_checkin ON checkin_photos(checkin_id, created_at);

CREATE TABLE project_suggestions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  checkin_id TEXT NOT NULL REFERENCES project_checkins(id),
  kind TEXT NOT NULL,                       -- step | upkeep
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  list TEXT NOT NULL DEFAULT 'todo',        -- todo | someday
  recurrence TEXT,                          -- upkeep: JSON rule, see public/js/lib/recurrence.js
  status TEXT NOT NULL DEFAULT 'new',       -- new | added | dismissed
  task_id TEXT REFERENCES tasks(id),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX project_suggestions_project ON project_suggestions(project_id, status);

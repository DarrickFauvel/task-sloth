-- Asking Claude about one step of a project: a suggestion still waiting to be added, or a task in the project.
-- Claude answers and may reword the step or break it into sub-steps. A suggestion takes the change straight
-- away (its sub-steps become the task's checklist when it's added); a task offers it, to use or decline.
ALTER TABLE project_suggestions ADD COLUMN checklist TEXT;  -- JSON array of sub-step texts

CREATE TABLE step_questions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  suggestion_id TEXT REFERENCES project_suggestions(id),  -- asked about a suggestion…
  task_id TEXT REFERENCES tasks(id),                      -- …or a task (also set once the suggestion is added)
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'thinking',                -- thinking | ready | failed
  reply TEXT,                                             -- Claude's answer (JSON), once ready
  error TEXT,                                             -- why it failed, to show
  proposal TEXT,                                          -- tasks: open | used | declined; NULL when no change was offered
  asked_by TEXT REFERENCES users(id),
  asked_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX step_questions_project ON step_questions(project_id, created_at);
CREATE INDEX step_questions_task ON step_questions(task_id, created_at);

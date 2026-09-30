-- Which list a task sits on: inbox (added without details, waiting to be sorted by whoever added it),
-- todo (the normal list), waiting (on someone else) or someday ("maybe later").
ALTER TABLE tasks ADD COLUMN list TEXT NOT NULL DEFAULT 'todo';
ALTER TABLE tasks ADD COLUMN waiting_on TEXT;     -- who or what it's waiting on, when list = 'waiting'
ALTER TABLE tasks ADD COLUMN waiting_since TEXT;  -- YYYY-MM-DD it went on the waiting list
CREATE INDEX tasks_household_list ON tasks(household_id, list, status);

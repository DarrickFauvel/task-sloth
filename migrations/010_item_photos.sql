-- A photo can belong to one checklist item (e.g. which exact product to buy) instead of to the task itself.
-- Item photos are still task_photos rows, so they share the upload, serving, household checks and purge;
-- the task's own gallery and photo count leave them out.
ALTER TABLE task_photos ADD COLUMN item_id TEXT REFERENCES checklist_items(id);
CREATE INDEX task_photos_item ON task_photos(item_id);

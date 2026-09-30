-- "Places" became GTD-style contexts (@Target, @phone, @computer): same data, clearer names.
ALTER TABLE locations RENAME TO contexts;
ALTER TABLE tasks RENAME COLUMN location_id TO context_id;
DROP INDEX locations_name;
CREATE UNIQUE INDEX contexts_name ON contexts(household_id, name COLLATE NOCASE);
DROP INDEX tasks_location;
CREATE INDEX tasks_context ON tasks(context_id);

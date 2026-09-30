import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createTask } from "../src/services/tasks.js";
import { createProject } from "../src/services/projects.js";
import { cleanListQuery, listQueryString, taskListView } from "../src/web/task-list.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-test-"));
const actor = { id: "u1", householdId: "h1" };
const membership = { household: { id: "h1" }, members: [] };

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  const ts = new Date().toISOString();
  await db.batch([
    { sql: "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'a@example.com', 'Alice', ?)", args: [ts] },
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', ?)", args: [ts] },
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h2', 'Other', ?)", args: [ts] },
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES ('h1', 'u1', ?)", args: [ts] },
  ]);
});

after(() => rmSync(dir, { recursive: true, force: true }));

const titles = (list) => list.groups.flatMap((g) => g.tasks.map((t) => t.title)).sort();

test("the list query carries a project", () => {
  const q = cleanListQuery({ view: "all", project: "p1", tag: "errand" });
  assert.deepEqual(q, { view: "all", project: "p1", context: null, tag: "errand" });
  assert.equal(listQueryString(q), "view=all&project=p1&tag=errand");
  assert.equal(cleanListQuery({}).project, null);
});

test("a list narrowed to a project shows only that project's tasks", async () => {
  const kitchen = await createProject("h1", { name: "Kitchen", emoji: "🍳" });
  await createProject("h1", { name: "Garden" });
  await createTask(actor, { title: "paint cabinets", projectId: kitchen, list: "todo" });
  await createTask(actor, { title: "new tap", projectId: kitchen, list: "todo" });
  await createTask(actor, { title: "mow", list: "todo" });
  const today = "2026-09-30";

  const list = await taskListView({ userId: "u1", membership, view: "all", project: kitchen, today });
  assert.deepEqual(titles(list), ["new tap", "paint cabinets"]);
  assert.equal(list.project, kitchen);
  assert.equal(list.filterLabel, "🍳 Kitchen");
  assert.equal(list.canGroup, true);

  // Another household's project (or a made-up id) is ignored, like an unknown context.
  const theirs = await createProject("h2", { name: "Theirs" });
  const unfiltered = await taskListView({ userId: "u1", membership, view: "all", project: theirs, today });
  assert.deepEqual(titles(unfiltered), ["mow", "new tap", "paint cabinets"]);
  assert.equal(unfiltered.project, null);
});

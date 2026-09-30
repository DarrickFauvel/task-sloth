import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createTask } from "../src/services/tasks.js";
import { decorateTask, taskListView } from "../src/web/task-list.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-test-"));
const actor = { id: "u1", householdId: "h1" };
const membership = { household: { id: "h1" }, members: [{ id: "u1", name: "Alice", color: "#6d5dfc" }] };
const today = "2026-09-30";
const time = "14:30";
// The viewer's wall clock reads 14:30:20 at NOW.
const NOW = Date.parse("2026-09-30T14:30:20Z");
const list = (extra = {}) => taskListView({ userId: "u1", membership, view: "all", today, time, now: NOW, ...extra });
const group = (l, title) => l.groups.find((g) => g.tasks.some((t) => t.title === title))?.label;

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  const ts = new Date().toISOString();
  await db.batch([
    { sql: "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'a@example.com', 'Alice', ?)", args: [ts] },
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', ?)", args: [ts] },
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES ('h1', 'u1', ?)", args: [ts] },
  ]);
});

beforeEach(() => db.batch([{ sql: "DELETE FROM activity" }, { sql: "DELETE FROM tasks" }]));
after(() => rmSync(dir, { recursive: true, force: true }));

const add = (title, dueDate, dueTime) => createTask(actor, { title, list: "todo", dueDate, dueTime });

test("a task due earlier today moves to Overdue and says so", async () => {
  await add("pick up parcel", today, "12:00");
  await add("dentist", today, "16:00");
  await add("water plants", today);
  const l = await list();
  assert.equal(group(l, "pick up parcel"), "Overdue");
  assert.equal(group(l, "dentist"), "Today");
  assert.equal(group(l, "water plants"), "Today");
  const late = l.groups[0].tasks[0];
  assert.equal(late.dueText, "Today 12:00 · overdue");
  assert.equal(late.dueState, "overdue");
  const dentist = l.groups.flatMap((g) => g.tasks).find((t) => t.title === "dentist");
  assert.equal(dentist.dueText, "Today 16:00");
  assert.equal(dentist.dueState, "today");
});

test("without the viewer's time, only the date counts (as before)", async () => {
  await add("pick up parcel", today, "12:00");
  assert.equal(group(await list({ time: null }), "pick up parcel"), "Today");
});

test("the list refreshes itself a minute after the next due time, or at midnight", async () => {
  await add("dentist", today, "16:00");
  await add("call back", today, "14:30"); // due this minute: overdue from 14:31
  assert.equal((await list()).refreshAt, Date.parse("2026-09-30T14:31:00Z"));
  await db.run("UPDATE tasks SET deleted_at = ? WHERE title = 'call back'", [new Date(NOW).toISOString()]);
  assert.equal((await list()).refreshAt, Date.parse("2026-09-30T16:01:00Z"));
  await db.run("UPDATE tasks SET deleted_at = ?", [new Date(NOW).toISOString()]);
  assert.equal((await list()).refreshAt, Date.parse("2026-10-01T00:00:00Z"));
});

test("a finished task isn't called overdue", () => {
  const t = decorateTask({ title: "done", status: "done", due_date: today, due_time: "09:00" }, membership, today, time);
  assert.equal(t.dueText, "Today 09:00");
  assert.equal(t.dueState, "");
});

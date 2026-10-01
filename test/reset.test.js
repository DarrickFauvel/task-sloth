import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createTask, deleteTask, restoreTask, setDone, updateTask } from "../src/services/tasks.js";
import { lastResetAt, recordReset, RESET_EVERY_MS, resetDue, resetSummary, snoozeReset } from "../src/services/reset.js";
import { resetStepView } from "../src/web/reset-page.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-test-"));
const me = { id: "u1", householdId: "h1" };
const sam = { id: "u2", householdId: "h1" };
const longAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
const membership = {
  household: { id: "h1" },
  members: [{ id: "u1", name: "Alice", color: "#6d5dfc", joined_at: longAgo }, { id: "u2", name: "Sam", color: "#e0555f", joined_at: longAgo }],
};
const today = "2026-10-01";
const step = (key) => resetStepView({ step: key, userId: "u1", membership, today, time: "12:00" });
const titles = (view) => view.tasks.map((t) => t.title);

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  const ts = new Date().toISOString();
  await db.batch([
    { sql: "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'a@example.com', 'Alice', ?), ('u2', 's@example.com', 'Sam', ?)", args: [ts, ts] },
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', ?)", args: [ts] },
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES ('h1', 'u1', ?), ('h1', 'u2', ?)", args: [longAgo, longAgo] },
  ]);
});
beforeEach(() => db.batch([{ sql: "DELETE FROM activity" }, { sql: "DELETE FROM tasks" }]));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a reset is due a week after the last one, or after joining; Not now hides it for a day", async () => {
  const member = membership.members[0];
  assert.equal(await resetDue("h1", member), true, "joined a month ago, never reset");
  assert.equal(await resetDue("h1", { ...member, joined_at: new Date().toISOString() }), false, "just joined");
  await recordReset(me, { finished: 0, changed: 0, deleted: 0 });
  assert.ok(await lastResetAt("h1", "u1"));
  assert.equal(await resetDue("h1", member), false);
  assert.equal(await resetDue("h1", member, Date.now() + RESET_EVERY_MS + 1000), true);
  snoozeReset("u1", Date.now() + RESET_EVERY_MS);
  assert.equal(await resetDue("h1", member, Date.now() + RESET_EVERY_MS + 1000), false, "snoozed");
});

test("each step asks about the right tasks", async () => {
  await createTask(me, { title: "late", dueDate: "2026-09-28", list: "todo" });
  await createTask(me, { title: "soon", dueDate: "2026-10-03", list: "todo" });
  await createTask(sam, { title: "sam's late", dueDate: "2026-09-28", list: "todo" });
  await createTask(sam, { title: "shared soon", dueDate: "2026-10-02", list: "todo", assigneeId: null });
  await createTask(me, { title: "far off", dueDate: "2026-11-20", list: "todo" });
  await createTask(me, { title: "plumber", list: "waiting", waitingOn: "the plumber" });
  await createTask(me, { title: "someday", list: "someday" });
  await createTask(me, { title: "jotted", list: "inbox" });

  assert.equal((await step("inbox")).inboxCount, 1);
  assert.deepEqual(titles(await step("overdue")), ["late"]);
  assert.deepEqual(titles(await step("waiting")), ["plumber"]);
  const week = await step("week");
  assert.deepEqual(titles(week), ["shared soon", "soon"]);
  assert.deepEqual(week.tasks.map((t) => [t.shared, t.answers.includes("claim")]), [[true, true], [false, false]]);
  assert.deepEqual(titles(await step("later")), ["someday"]);
  assert.equal(await step("nope"), null);
});

test("the summary counts what changed since the reset started", async () => {
  const start = new Date(Date.now() - 1000).toISOString();
  const a = await createTask(me, { title: "a", list: "todo" });
  const b = await createTask(me, { title: "b", list: "todo" });
  const c = await createTask(me, { title: "c", list: "todo" });
  await db.run("UPDATE activity SET created_at = ?", [new Date(Date.now() - 5000).toISOString()]); // adding them was before the reset
  await db.run("UPDATE tasks SET created_at = ?", [longAgo]); // past being set up, so edits are logged
  await setDone(me, a, true, { today });
  await updateTask(me, b, { dueDate: "2026-10-05" });
  await deleteTask(me, c);
  await restoreTask(me, c);
  assert.deepEqual(await resetSummary("h1", "u1", start), { finished: 1, changed: 1, deleted: 0 });
});

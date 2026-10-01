import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createTask, setDone } from "../src/services/tasks.js";
import { DONE_WINDOW_MS, LINGER_MS, taskListView } from "../src/web/task-list.js";
import { activityView } from "../src/web/activity-page.js";
import { hideDone } from "../src/web/hidden-done.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-test-"));
const actor = { id: "u1", householdId: "h1" };
const membership = { household: { id: "h1" }, members: [{ id: "u1", name: "Alice Smith", color: "#6d5dfc" }] };
const today = "2026-09-30";
const NOW = Date.parse("2026-09-30T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  const ts = new Date().toISOString();
  await db.batch([
    { sql: "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'a@example.com', 'Alice Smith', ?)", args: [ts] },
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', ?)", args: [ts] },
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES ('h1', 'u1', ?)", args: [ts] },
  ]);
});

after(() => rmSync(dir, { recursive: true, force: true }));

/** A to-do task finished `msAgo` before NOW (or still open). */
async function task(title, msAgo = null) {
  const id = await createTask(actor, { title, list: "todo" });
  if (msAgo !== null) await db.run("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?", [ago(msAgo), id]);
  return id;
}

const titles = (list) => list.groups.flatMap((g) => g.tasks.map((t) => t.title)).sort();

test("a finished task stays on its list for 10 minutes, then the Done tab keeps it for 24 hours", async () => {
  await task("open one");
  await task("just done", 2 * 60_000);
  await task("done a while ago", 30 * 60_000);
  await task("done last night", 20 * 3_600_000);
  await task("done the day before", 30 * 3_600_000);

  const all = await taskListView({ userId: "u1", membership, view: "all", today, now: NOW });
  assert.deepEqual(titles(all), ["just done", "open one"]);
  // It re-renders when "just done" drops off: 8 minutes from now.
  assert.equal(all.refreshAt, NOW - 2 * 60_000 + LINGER_MS);

  const done = await taskListView({ userId: "u1", membership, view: "done", today, now: NOW });
  assert.deepEqual(titles(done), ["done a while ago", "done last night", "just done"]);
  // The oldest one drops off first.
  assert.equal(done.refreshAt, NOW - 20 * 3_600_000 + DONE_WINDOW_MS);
});

test("a list with nothing finished lately has nothing to refresh", async () => {
  const inbox = await taskListView({ userId: "u1", membership, view: "inbox", today, now: NOW });
  assert.equal(inbox.refreshAt, null);
});

test("hiding a finished task takes it off your lists now, but not Done or anyone else's", async () => {
  const id = await task("hide me", 60_000);
  const { completed_at } = await db.get("SELECT completed_at FROM tasks WHERE id = ?", [id]);
  hideDone("u1", id, completed_at, Date.parse(completed_at) + LINGER_MS);

  const list = (userId, view) => taskListView({ userId, membership, view, today, now: NOW }).then(titles);
  assert.ok(!(await list("u1", "all")).includes("hide me"));
  assert.ok((await list("u2", "all")).includes("hide me"));
  assert.ok((await list("u1", "done")).includes("hide me"));

  // Reopened and finished again: it's a new completion, so it shows again.
  await db.run("UPDATE tasks SET completed_at = ? WHERE id = ?", [ago(30_000), id]);
  assert.ok((await list("u1", "all")).includes("hide me"));
});

test("the Activity page covers the last 14 days, grouped by day", async () => {
  const id = await task("water plants");
  await setDone(actor, id, true);
  await db.run("UPDATE activity SET created_at = ? WHERE task_id = ? AND verb = 'created'", [ago(15 * 86_400_000), id]);
  await db.run("UPDATE activity SET created_at = ? WHERE task_id = ? AND verb = 'completed'", [ago(3_600_000), id]);

  const { days } = await activityView({ userId: "u1", membership, timeZone: "UTC", today, now: NOW });
  const entries = days.flatMap((d) => d.entries.map((e) => `${d.label}: ${e.text} ${e.title}`));
  assert.ok(entries.includes("Today: You completed water plants"));
  assert.ok(!entries.some((e) => e.includes("added water plants")), "the 15-day-old entry is left out");
});

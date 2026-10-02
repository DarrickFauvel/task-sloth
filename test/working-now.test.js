import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createTask, getTask, isWorking, setDone, startWorking, stopWorking, updateTask } from "../src/services/tasks.js";
import { taskListView } from "../src/web/task-list.js";
import { buildActivity } from "../src/web/activity-page.js";
import { listActivity } from "../src/services/activity.js";
import { nextMidnight } from "../public/js/lib/dates.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-working-"));
const me = { id: "u1", householdId: "h1" };
const sam = { id: "u2", householdId: "h1" };
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();
const membership = {
  household: { id: "h1", name: "Home" },
  members: [{ id: "u1", name: "Alice", color: "#f00" }, { id: "u2", name: "Sam Lee", color: "#0f0" }],
};

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  const ts = new Date().toISOString();
  await db.batch([
    { sql: "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'a@example.com', 'Alice', ?), ('u2', 's@example.com', 'Sam Lee', ?)", args: [ts, ts] },
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', ?)", args: [ts] },
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES ('h1', 'u1', ?), ('h1', 'u2', ?)", args: [ts, ts] },
  ]);
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("starting a task nobody has makes it yours and marks you on it", async () => {
  const id = await createTask(me, { title: "fold laundry", assigneeId: null });
  await startWorking(me, id, { until: tomorrow() });
  const t = await getTask("h1", id);
  assert.equal(t.assignee_id, "u1");
  assert.equal(t.working_by, "u1");
  assert.ok(isWorking(t));
});

test("helping with someone else's task keeps it theirs", async () => {
  const id = await createTask(sam, { title: "clean garage" });
  await startWorking(me, id, { until: tomorrow() });
  const t = await getTask("h1", id);
  assert.equal(t.assignee_id, "u2");
  assert.equal(t.working_by, "u1");
});

test("one task at a time: starting another ends the first", async () => {
  const a = await createTask(me, { title: "vacuum" });
  const b = await createTask(me, { title: "dust" });
  await startWorking(me, a, { until: tomorrow() });
  await startWorking(me, b, { until: tomorrow() });
  assert.equal((await getTask("h1", a)).working_by, null);
  assert.equal((await getTask("h1", b)).working_by, "u1");
  const c = await createTask(sam, { title: "mow" });
  await startWorking(sam, c, { until: tomorrow() });
  assert.equal((await getTask("h1", b)).working_by, "u1", "someone else starting doesn't touch yours");
});

test("finishing, stopping, leaving To do or handing it to someone else ends it", async () => {
  const done = await createTask(me, { title: "a" });
  await startWorking(me, done, { until: tomorrow() });
  await setDone(me, done, true);
  assert.equal((await getTask("h1", done)).working_by, null);

  const stopped = await createTask(me, { title: "b" });
  await startWorking(me, stopped, { until: tomorrow() });
  await stopWorking(me, stopped);
  assert.equal((await getTask("h1", stopped)).working_by, null);

  const parked = await createTask(me, { title: "c" });
  await startWorking(me, parked, { until: tomorrow() });
  await updateTask(me, parked, { list: "someday" });
  assert.equal((await getTask("h1", parked)).working_by, null);

  const handed = await createTask(me, { title: "d" });
  await startWorking(me, handed, { until: tomorrow() });
  await updateTask(me, handed, { notes: "keep going" });
  assert.equal((await getTask("h1", handed)).working_by, "u1", "other edits leave it alone");
  await updateTask(me, handed, { assigneeId: "u2" });
  assert.equal((await getTask("h1", handed)).working_by, null);
});

test("only To do tasks can be started", async () => {
  const id = await createTask(me, { title: "someday thing", list: "someday" });
  await assert.rejects(startWorking(me, id, { until: tomorrow() }), /To do first/);
});

test("it lapses at the end of the day it was started", () => {
  const task = { working_by: "u1", working_until: "2026-10-03T04:00:00.000Z" };
  assert.ok(isWorking(task, "2026-10-03T03:59:00.000Z"));
  assert.ok(!isWorking(task, "2026-10-03T04:00:00.000Z"));
  assert.equal(nextMidnight("America/New_York", new Date("2026-10-02T23:30:00Z")).toISOString(), "2026-10-03T04:00:00.000Z");
  // The night the clocks go back still ends at midnight local time.
  assert.equal(nextMidnight("America/New_York", new Date("2026-11-01T02:00:00Z")).toISOString(), "2026-11-01T04:00:00.000Z");
});

test("lists put what people are working on first, and re-render when it lapses", async () => {
  await db.run("UPDATE tasks SET working_by = NULL, working_since = NULL, working_until = NULL");
  const later = await createTask(me, { title: "due today", dueDate: "2026-10-02" });
  const now = await createTask(me, { title: "doing it", dueDate: "2026-10-09" });
  const until = tomorrow();
  await startWorking(me, now, { until });
  for (const groupBy of ["when", "where"]) {
    const list = await taskListView({ userId: "u1", membership, view: "all", groupBy, today: "2026-10-02" });
    assert.equal(list.groups[0].label, "Working on now");
    assert.deepEqual(list.groups[0].tasks.map((t) => t.title), ["doing it"]);
    assert.equal(list.groups[0].tasks[0].worker.id, "u1");
    assert.ok(!list.groups.slice(1).some((g) => g.tasks.some((t) => t.id === now)), "not listed twice");
    assert.ok(list.groups.slice(1).some((g) => g.tasks.some((t) => t.id === later)));
    assert.ok(list.refreshAt <= Date.parse(until));
  }
  await db.run("UPDATE tasks SET working_until = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", now]);
  const lapsed = await taskListView({ userId: "u1", membership, view: "all", today: "2026-10-02" });
  assert.notEqual(lapsed.groups[0].label, "Working on now");
});

test("starting and stopping show in Activity only under every change", async () => {
  const id = await createTask(me, { title: "logged" });
  await db.run("UPDATE activity SET created_at = '2026-01-01T00:00:00.000Z' WHERE task_id = ?", [id]);
  await startWorking(me, id, { until: tomorrow() });
  await stopWorking(me, id);
  const rows = await listActivity("h1", { taskId: id });
  const opts = { membersById: Object.fromEntries(membership.members.map((m) => [m.id, m])), userId: "u1", timeZone: "UTC", today: new Date().toISOString().slice(0, 10) };
  const text = (all) => buildActivity(rows, { ...opts, all }).flatMap((d) => d.entries).map((e) => e.text).join(" | ");
  assert.ok(!text(false).includes("working on"));
  assert.match(text(true), /You started working on and stopped working on/);
});

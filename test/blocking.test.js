import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createTask, deleteTask, getTask, listBlockedBy, listTasks, setDone, updateTask } from "../src/services/tasks.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-blocking-"));
const me = { id: "u1", householdId: "h1" };

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  const ts = new Date().toISOString();
  await db.batch([
    { sql: "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'a@example.com', 'Alice', ?)", args: [ts] },
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', ?), ('h2', 'Other', ?)", args: [ts, ts] },
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES ('h1', 'u1', ?)", args: [ts] },
  ]);
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("a blocked task stays on its list, shows its blocker, and appears under Waiting", async () => {
  const walls = await createTask(me, { title: "patch the walls" });
  const paint = await createTask(me, { title: "paint the bedroom", waitingTaskId: walls });
  const t = await getTask("h1", paint);
  assert.equal(t.list, "todo");
  assert.equal(t.waiting_task_title, "patch the walls");
  assert.deepEqual(JSON.parse((await getTask("h1", walls)).blocking_titles), ["paint the bedroom"]);
  const waiting = (await listTasks("h1", { status: "open", waiting: true })).map((x) => x.title);
  assert.ok(waiting.includes("paint the bedroom"));
  assert.ok(!waiting.includes("patch the walls"));
});

test("finishing the blocker unblocks what it held up", async () => {
  const a = await createTask(me, { title: "buy paint" });
  const b = await createTask(me, { title: "paint fence", waitingTaskId: a });
  const c = await createTask(me, { title: "paint shed", waitingTaskId: a });
  assert.deepEqual((await listBlockedBy("h1", a)).map((x) => x.title), ["paint fence", "paint shed"]);
  await setDone(me, a, true);
  assert.equal((await getTask("h1", b)).waiting_task_id, null);
  assert.equal((await getTask("h1", c)).waiting_task_id, null);
  const verbs = await db.all("SELECT verb FROM activity WHERE task_id = ? ORDER BY created_at", [b]);
  assert.ok(verbs.some((v) => v.verb === "unblocked"));
});

test("deleting the blocker unblocks too", async () => {
  const a = await createTask(me, { title: "order part" });
  const b = await createTask(me, { title: "fix bike", waitingTaskId: a });
  await deleteTask(me, a);
  assert.equal((await getTask("h1", b)).waiting_task_id, null);
});

test("guards: not itself, not a finished task, not another household's, no circles", async () => {
  const a = await createTask(me, { title: "a" });
  const b = await createTask(me, { title: "b", waitingTaskId: a });
  const c = await createTask(me, { title: "c", waitingTaskId: b });
  await assert.rejects(updateTask(me, a, { waitingTaskId: a }), /itself/);
  await assert.rejects(updateTask(me, a, { waitingTaskId: b }), /each other/, "a -> b -> a");
  await assert.rejects(updateTask(me, a, { waitingTaskId: c }), /each other/, "a -> c -> b -> a");
  const done = await createTask(me, { title: "done already" });
  await setDone(me, done, true);
  await assert.rejects(updateTask(me, a, { waitingTaskId: done }), /already done/);
  const theirs = await createTask({ id: "u1", householdId: "h2" }, { title: "theirs", assigneeId: null });
  await assert.rejects(updateTask(me, a, { waitingTaskId: theirs }), /Unknown task/);
  // Clearing it is always fine.
  await updateTask(me, b, { waitingTaskId: null });
  assert.equal((await getTask("h1", b)).waiting_task_id, null);
});

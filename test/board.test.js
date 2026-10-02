import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createTask, getTask, moveTask, setDone, startWorking } from "../src/services/tasks.js";
import { boardColumns, taskListView } from "../src/web/task-list.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-board-"));
const me = { id: "u1", householdId: "h1" };
const sam = { id: "u2", householdId: "h1" };
const until = () => new Date(Date.now() + 86_400_000).toISOString();
const membership = {
  household: { id: "h1", name: "Home" },
  members: [{ id: "u1", name: "Alice", color: "#f00" }, { id: "u2", name: "Sam Lee", color: "#0f0" }],
};
const columnsOf = async (view = "all") => {
  const cols = await boardColumns({ householdId: "h1", userId: "u1", membership, view, today: "2026-10-02" });
  return Object.fromEntries(cols.map((c) => [c.key, c.tasks.map((t) => t.title)]));
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
beforeEach(async () => {
  await db.run("UPDATE tasks SET deleted_at = ? WHERE deleted_at IS NULL", [new Date().toISOString()]);
});

test("each task lands in the column for where it is", async () => {
  await createTask(me, { title: "plain" });
  const doing = await createTask(me, { title: "doing" });
  await startWorking(me, doing, { until: until() });
  await createTask(me, { title: "waiting", list: "waiting", waitingOn: "the plumber" });
  const blocker = await createTask(me, { title: "first" });
  await createTask(me, { title: "blocked", waitingTaskId: blocker });
  const finished = await createTask(me, { title: "finished" });
  await setDone(me, finished, true);
  await createTask(me, { title: "someday", list: "someday" });
  assert.deepEqual(await columnsOf(), {
    todo: ["plain", "first"],
    doing: ["doing"],
    waiting: ["waiting", "blocked"],
    done: ["finished"],
  });
});

test("the tab's who applies: Mine, Everyone, Up for grabs", async () => {
  await createTask(me, { title: "mine" });
  await createTask(me, { title: "sam's", assigneeId: "u2" });
  await createTask(me, { title: "nobody's", assigneeId: null });
  assert.deepEqual((await columnsOf("mine")).todo, ["mine"]);
  assert.deepEqual((await columnsOf("grabs")).todo, ["nobody's"]);
  assert.equal((await columnsOf("all")).todo.length, 3);
});

test("moving a card does what the column means", async () => {
  const id = await createTask(me, { title: "fix the gate", assigneeId: null });
  await moveTask(me, id, "doing", { until: until() });
  let t = await getTask("h1", id);
  assert.deepEqual([t.working_by, t.assignee_id], ["u1", "u1"], "Doing starts it (and takes a nobody's task)");
  await moveTask(me, id, "waiting");
  t = await getTask("h1", id);
  assert.deepEqual([t.list, t.working_by], ["waiting", null], "Waiting on stops work and moves it to the Waiting list");
  await moveTask(me, id, "doing", { until: until() });
  t = await getTask("h1", id);
  assert.deepEqual([t.list, t.working_by], ["todo", "u1"], "from Waiting straight to Doing");
  await moveTask(me, id, "done", { today: "2026-10-02" });
  t = await getTask("h1", id);
  assert.deepEqual([t.status, t.working_by], ["done", null]);
  await moveTask(me, id, "todo");
  t = await getTask("h1", id);
  assert.deepEqual([t.status, t.list, t.working_by], ["open", "todo", null], "back to To do reopens it");
  await assert.rejects(moveTask(me, id, "sideways"), /Unknown column/);
});

test("someone else's Doing task stays theirs when you help", async () => {
  const id = await createTask(sam, { title: "sam's job" });
  await moveTask(me, id, "doing", { until: until() });
  const t = await getTask("h1", id);
  assert.deepEqual([t.assignee_id, t.working_by], ["u2", "u1"]);
});

test("View as: Board on the to-do tabs only", async () => {
  await createTask(me, { title: "x" });
  const board = await taskListView({ userId: "u1", membership, view: "all", layout: "board", today: "2026-10-02" });
  assert.equal(board.layout, "board");
  assert.deepEqual(board.columns.map((c) => c.label), ["To do", "Doing", "Waiting on", "Done today"]);
  const waiting = await taskListView({ userId: "u1", membership, view: "waiting", layout: "board", today: "2026-10-02" });
  assert.equal(waiting.layout, "list");
  assert.equal(waiting.canBoard, false);
});

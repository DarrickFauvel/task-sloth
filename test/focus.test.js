import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createTask, getTask, startWorking } from "../src/services/tasks.js";
import {
  completeInSession, endFocus, focusChoices, getFocus, householdSessions, resumeFocus, sessionDone, sessionQueue,
  setAsideInSession, skipInSession, startFocus,
} from "../src/services/focus.js";
import { focusLines, focusPageView } from "../src/web/focus-page.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-focus-"));
const me = { id: "u1", householdId: "h1" };
const sam = { id: "u2", householdId: "h1" };
const until = () => new Date(Date.now() + 86_400_000).toISOString();
const membership = {
  household: { id: "h1", name: "Home" },
  members: [{ id: "u1", name: "Alice", color: "#f00" }, { id: "u2", name: "Sam Lee", color: "#0f0" }],
};
const titles = (tasks) => tasks.map((t) => t.title);

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  const ts = new Date().toISOString();
  await db.batch([
    { sql: "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'a@example.com', 'Alice', ?), ('u2', 's@example.com', 'Sam Lee', ?)", args: [ts, ts] },
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', ?)", args: [ts] },
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES ('h1', 'u1', ?), ('h1', 'u2', ?)", args: [ts, ts] },
    { sql: "INSERT INTO contexts (id, household_id, name, created_at) VALUES ('target', 'h1', 'Target', ?), ('phone', 'h1', 'phone', ?)", args: [ts, ts] },
    { sql: "INSERT INTO projects (id, household_id, name, emoji, created_at, updated_at) VALUES ('party', 'h1', 'Party', '🎂', ?, ?)", args: [ts, ts] },
  ]);
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  await db.run("DELETE FROM focus_sessions");
  await db.run("UPDATE tasks SET deleted_at = ? WHERE deleted_at IS NULL", [new Date().toISOString()]);
});

test("a session takes yours and nobody's, ready to do, and not what someone else is on", async () => {
  await createTask(me, { title: "mine", contextId: "target" });
  await createTask(me, { title: "nobody's", contextId: "target", assigneeId: null });
  await createTask(me, { title: "sam's", contextId: "target", assigneeId: "u2" });
  await createTask(me, { title: "elsewhere", contextId: "phone" });
  await createTask(me, { title: "someday", contextId: "target", list: "someday" });
  const blocker = await createTask(me, { title: "first this", contextId: "phone" });
  await createTask(me, { title: "blocked", contextId: "target", waitingTaskId: blocker });
  const helping = await createTask(me, { title: "sam is on it", contextId: "target", assigneeId: null });
  await startWorking(sam, helping, { until: until() });

  const session = await startFocus(me, { contextId: "target" }, { until: until() });
  assert.deepEqual(titles(await sessionQueue(me, session)), ["mine", "nobody's"]);
  const first = await getTask("h1", (await sessionQueue(me, session))[0].id);
  assert.equal(first.working_by, "u1", "the task on screen is the one you're working on");
});

test("the task nobody had becomes yours; Not today hands it back and moves on", async () => {
  const grab = await createTask(me, { title: "nobody's", contextId: "target", assigneeId: null, dueDate: "2098-01-01" });
  await createTask(me, { title: "mine", contextId: "target", dueDate: "2099-01-01" });
  const session = await startFocus(me, { contextId: "target" }, { until: until() });
  assert.equal((await getTask("h1", grab)).assignee_id, "u1");
  await setAsideInSession(me, session, grab);
  const t = await getTask("h1", grab);
  assert.equal(t.assignee_id, null);
  assert.equal(t.working_by, null);
  const queue = await sessionQueue(me, await getFocus(me));
  assert.deepEqual(titles(queue), ["mine"]);
  assert.equal((await getTask("h1", queue[0].id)).working_by, "u1");
});

test("Skip sends it to the back; Done counts and brings up the next", async () => {
  const a = await createTask(me, { title: "a", projectId: "party", dueDate: "2099-01-01" });
  const b = await createTask(me, { title: "b", projectId: "party", dueDate: "2099-01-02" });
  await createTask(me, { title: "c", projectId: "party", dueDate: "2099-01-03" });
  let session = await startFocus(me, { projectId: "party" }, { until: until() });
  await skipInSession(me, session, a);
  session = await getFocus(me);
  assert.deepEqual(titles(await sessionQueue(me, session)), ["b", "c", "a"]);
  assert.equal((await getTask("h1", a)).working_by, null);
  assert.equal((await getTask("h1", b)).working_by, "u1");
  await completeInSession(me, session, b, { today: "2026-10-02" });
  assert.equal(await sessionDone(me, session), 1);
  assert.deepEqual(titles(await sessionQueue(me, session)), ["c", "a"]);
  await assert.rejects(completeInSession(me, session, b, { today: "2026-10-02" }), /isn't up/, "an old page can't act on a finished task");
});

test("one session at a time, and ending it stops work on the task on screen", async () => {
  const t = await createTask(me, { title: "call", contextId: "phone" });
  await createTask(me, { title: "buy", contextId: "target" });
  await startFocus(me, { contextId: "target" }, { until: until() });
  const session = await startFocus(me, { contextId: "phone" }, { until: until() });
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM focus_sessions WHERE user_id = 'u1' AND ended_at IS NULL")).n, 1);
  assert.equal((await getTask("h1", t)).working_by, "u1");
  assert.equal(await endFocus(me, session), 0);
  assert.equal(await getFocus(me), null);
  assert.equal((await getTask("h1", t)).working_by, null);
});

test("coming back picks the session's task up again", async () => {
  const t = await createTask(me, { title: "in session", contextId: "target" });
  const other = await createTask(me, { title: "something else" });
  const session = await startFocus(me, { contextId: "target" }, { until: until() });
  await startWorking(me, other, { until: until() });
  assert.equal((await getTask("h1", t)).working_by, null);
  await resumeFocus(me, session);
  assert.equal((await getTask("h1", t)).working_by, "u1");
});

test("a session lapses at the end of the day", async () => {
  await createTask(me, { title: "x", contextId: "target" });
  await startFocus(me, { contextId: "target" }, { until: "2000-01-01T00:00:00.000Z" });
  assert.equal(await getFocus(me), null);
});

test("the household sees who's focusing on what, and the page shows the task, progress and what's next", async () => {
  await createTask(me, { title: "first", contextId: "target", dueDate: "2099-01-01" });
  await createTask(me, { title: "second", contextId: "target", dueDate: "2099-01-02" });
  await startFocus(me, { contextId: "target" }, { until: until() });
  assert.deepEqual(await householdSessions("h1"), [{ userId: "u1", target: { kind: "context", id: "target", name: "Target" }, done: 0, total: 2 }]);
  assert.deepEqual((await focusLines("h1", membership, "u2")).map((l) => l.text), ["Alice is focusing on @Target · 0 of 2 done"]);
  assert.equal((await focusLines("h1", membership, "u1"))[0].text, "You're focusing on @Target · 0 of 2 done");
  const page = await focusPageView({ actor: me, membership, today: "2026-10-02" });
  assert.equal(page.current.title, "first");
  assert.equal(page.next, "second");
  assert.equal(page.target.label, "@Target");
  assert.deepEqual([page.done, page.total], [0, 2]);
});

test("choices count what you could take on in each project and place", async () => {
  await createTask(me, { title: "a", contextId: "target", projectId: "party" });
  await createTask(me, { title: "b", contextId: "target" });
  await createTask(me, { title: "sam's", contextId: "phone", assigneeId: "u2" });
  const { projects, contexts } = await focusChoices(me);
  assert.deepEqual(projects.map((c) => [c.name, c.count]), [["Party", 1]]);
  assert.deepEqual(contexts.map((c) => [c.name, c.count]), [["Target", 2]]);
  await assert.rejects(startFocus(me, {}, { until: until() }), /Pick a project/);
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createTask, getTask, inboxCount, listTasks, nextToSort, updateTask } from "../src/services/tasks.js";
import { addedFlash, quickAddList } from "../src/web/task-list.js";
import { nextSortUrl, SORT_CHOICES, sortDecision } from "../src/web/sort-page.js";
import { sinceLabel } from "../public/js/lib/dates.js";

test("quickAddList: bare titles go to the inbox, details skip it", () => {
  assert.equal(quickAddList({ title: "x" }, "mine"), "inbox");
  assert.equal(quickAddList({ title: "x", priority: 1 }, "mine"), "inbox", "priority alone isn't a detail");
  assert.equal(quickAddList({ title: "x", dueDate: "2026-10-01" }, "mine"), "todo");
  assert.equal(quickAddList({ title: "x", assigneeId: "u1" }, "all"), "todo");
  assert.equal(quickAddList({ title: "x", assigneeId: null }, "all"), "todo", "@anyone counts");
  assert.equal(quickAddList({ title: "x", contextName: "target" }, "inbox"), "todo");
  assert.equal(quickAddList({ title: "x", tags: ["kids"] }, "mine"), "todo");
  assert.equal(quickAddList({ title: "x" }, "waiting"), "waiting", "adding on a tab puts it there");
  assert.equal(quickAddList({ title: "x", dueDate: "2026-10-01" }, "someday"), "someday");
});

test("addedFlash says where a quick add went when it isn't on this tab", () => {
  assert.equal(addedFlash({ id: "t", list: "inbox" }, "inbox", "u1"), null);
  assert.deepEqual(addedFlash({ id: "t", list: "inbox" }, "mine", "u1").link, { href: "/sort?task=t", label: "Sort it now" });
  assert.equal(addedFlash({ id: "t", list: "todo", assigneeId: "u1" }, "mine", "u1"), null);
  assert.equal(addedFlash({ id: "t", list: "todo", assigneeId: "u2" }, "all", "u1"), null, "Everyone shows it all");
  assert.equal(addedFlash({ id: "t", list: "todo", assigneeId: null }, "grabs", "u1"), null);
  assert.equal(addedFlash({ id: "t", list: "todo", assigneeId: "u2" }, "mine", "u1").message, "Added to Everyone.");
  assert.equal(addedFlash({ id: "t", list: "todo", assigneeId: null }, "mine", "u1").message, "Added to Up for grabs.");
  assert.equal(addedFlash({ id: "t", list: "todo", assigneeId: "u1" }, "inbox", "u1").message, "Added to Mine.");
  assert.equal(addedFlash({ id: "t", list: "waiting" }, "waiting", "u1"), null);
});

test("nextSortUrl: answering goes back to the oldest, unless something was skipped", () => {
  assert.equal(nextSortUrl("t"), "/sort");
  assert.equal(nextSortUrl("t", { skipping: true }), "/sort?after=t");
  assert.equal(nextSortUrl("t", { deleted: true }), "/sort?undo=t");
});

test("sortDecision maps each answer", () => {
  assert.deepEqual(sortDecision({ choice: "now", title: " Call mom " }), { action: "done", input: { title: "Call mom", list: "todo" } });
  assert.deepEqual(sortDecision({ choice: "todo", title: "", context: " home  depot ", assigneeId: "" }), {
    action: "update", input: { list: "todo", assigneeId: null, contextName: "home depot" },
  });
  assert.deepEqual(sortDecision({ choice: "date", dueDate: "2026-10-03" }).input, { list: "todo", dueDate: "2026-10-03" });
  assert.deepEqual(sortDecision({ choice: "waiting", waitingOn: "plumber" }).input, { list: "waiting", waitingOn: "plumber" });
  assert.deepEqual(sortDecision({ choice: "someday" }).input, { list: "someday" });
  assert.deepEqual(sortDecision({ choice: "delete", title: "ignored" }), { action: "delete", input: {} });
});

test("sortDecision rejects a missing date or an unknown answer", () => {
  assert.throws(() => sortDecision({ choice: "date", dueDate: "" }), /Pick a date/);
  assert.throws(() => sortDecision({ choice: "" }), /Pick one/);
  assert.throws(() => sortDecision({}), /Pick one/);
});

test("every sort choice has plain-language help", () => {
  for (const c of SORT_CHOICES) assert.ok(c.label && c.hint && c.short && c.icon, c.value);
});

test("sinceLabel", () => {
  assert.equal(sinceLabel("2026-09-30", "2026-09-30"), "since today");
  assert.equal(sinceLabel("2026-09-29", "2026-09-30"), "1 day");
  assert.equal(sinceLabel("2026-09-20", "2026-09-30"), "10 days");
  assert.equal(sinceLabel("2026-09-01", "2026-09-30"), "4 weeks");
});

// --- services, against a throwaway database ------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "task-sloth-inbox-"));
const me = { id: "u1", householdId: "h1" };
const sam = { id: "u2", householdId: "h1" };

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  const ts = new Date().toISOString();
  await db.batch([
    { sql: "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'a@example.com', 'Alice', ?), ('u2', 's@example.com', 'Sam', ?)", args: [ts, ts] },
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', ?)", args: [ts] },
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES ('h1', 'u1', ?), ('h1', 'u2', ?)", args: [ts, ts] },
  ]);
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("existing and default tasks are on the To do list", async () => {
  const id = await createTask(me, { title: "plain" });
  assert.equal((await getTask("h1", id)).list, "todo");
});

test("the inbox is personal, and nextToSort walks it oldest first with skipping", async () => {
  const a = await createTask(me, { title: "a", list: "inbox" });
  const b = await createTask(me, { title: "b", list: "inbox" });
  await createTask(sam, { title: "sam's", list: "inbox" });

  assert.equal(await inboxCount("h1", "u1"), 2);
  assert.deepEqual((await listTasks("h1", { list: "inbox", creatorId: "u1", status: "open" })).map((t) => t.title), ["a", "b"]);
  assert.equal((await nextToSort("h1", "u1")).task.id, a);
  assert.equal((await nextToSort("h1", "u1", a)).task.id, b, "skip a");
  const end = await nextToSort("h1", "u1", b);
  assert.equal(end.task, null);
  assert.equal(end.left, 2, "skipped ones still count");
  // Opened on the newest (from the "Added to your Inbox" toast) and answered: the older one is still next.
  assert.equal((await nextToSort("h1", "u1")).task.id, a, "no cursor after an answer");
  // The inbox tasks don't show on the shared To do list.
  assert.ok(!(await listTasks("h1", { list: "todo", status: "open" })).some((t) => ["a", "b", "sam's"].includes(t.title)));
});

test("moving to Waiting starts the clock; moving off forgets who", async () => {
  const id = await createTask(me, { title: "fix sink", list: "inbox" });
  await updateTask(me, id, { list: "waiting", waitingOn: " the plumber " });
  let t = await getTask("h1", id);
  assert.equal(t.list, "waiting");
  assert.equal(t.waiting_on, "the plumber");
  assert.match(t.waiting_since, /^\d{4}-\d{2}-\d{2}$/);

  await updateTask(me, id, { list: "todo" });
  t = await getTask("h1", id);
  assert.equal(t.waiting_on, null);
  assert.equal(t.waiting_since, null);
});

test("creating straight onto Waiting sets the date; unknown lists are rejected", async () => {
  const id = await createTask(me, { title: "parcel", list: "waiting" });
  assert.ok((await getTask("h1", id)).waiting_since);
  await assert.rejects(createTask(me, { title: "x", list: "later" }), /Unknown list/);
});

test("quickDates offers today, tomorrow, the weekend, Monday and a week out, without repeats", async () => {
  const { quickDates } = await import("../src/web/sort-page.js");
  // 2026-09-30 is a Wednesday.
  assert.deepEqual(quickDates("2026-09-30"), [
    { date: "2026-09-30", label: "Today" },
    { date: "2026-10-01", label: "Tomorrow" },
    { date: "2026-10-03", label: "Sat" },
    { date: "2026-10-05", label: "Mon" },
    { date: "2026-10-07", label: "In a week" },
  ]);
  // On a Friday, Saturday is tomorrow: it shows once, as "Tomorrow".
  assert.deepEqual(quickDates("2026-10-02").map((d) => d.label), ["Today", "Tomorrow", "Mon", "In a week"]);
});

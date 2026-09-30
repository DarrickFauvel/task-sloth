import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { copyTask, createTask, getTask, listTasks, tagList, updateTask } from "../src/services/tasks.js";
import { ensureContext, listContexts } from "../src/services/contexts.js";
import { listTags } from "../src/services/tags.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-test-"));
const actor = { id: "u1", householdId: "h1" };

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

test("ensureContext reuses a context whatever the case, per household", async () => {
  const a = await ensureContext("h1", "Target");
  assert.equal(await ensureContext("h1", "  target "), a);
  assert.notEqual(await ensureContext("h2", "Target"), a);
  assert.deepEqual((await listContexts("h1")).map((l) => l.name), ["Target"]);
  const depot = await ensureContext("h1", "home depot");
  assert.equal((await listContexts("h1")).find((l) => l.id === depot).name, "Home Depot");
  assert.equal(await ensureContext("h1", "HOME DEPOT"), depot);
});

test("tasks carry a context and tags, and lists filter by them", async () => {
  const target = await ensureContext("h1", "Target");
  const id = await createTask(actor, { title: "ink", contextId: target, tags: ["errand", "Quick Win", "errand"] });
  await createTask(actor, { title: "mow", tags: ["yard"] });

  const task = await getTask("h1", id);
  assert.equal(task.context_name, "Target");
  assert.deepEqual(tagList(task), ["errand", "quick-win"]);

  assert.deepEqual((await listTasks("h1", { contextId: target })).map((t) => t.title), ["ink"]);
  assert.deepEqual((await listTasks("h1", { tag: "errand" })).map((t) => t.title), ["ink"]);
  assert.deepEqual((await listTasks("h1", { tag: "yard" })).map((t) => t.title), ["mow"]);
  assert.equal((await listTags("h1")).find((g) => g.name === "errand").open_count, 1);
});

test("updateTask replaces tags and clears a context", async () => {
  const id = await createTask(actor, { title: "bulbs", contextId: await ensureContext("h1", "Lowe's"), tags: ["errand"] });
  await updateTask(actor, id, { tags: ["home", "errand"], contextId: null });
  const task = await getTask("h1", id);
  assert.deepEqual(tagList(task), ["errand", "home"]);
  assert.equal(task.context_id, null);

  // Only a tag change still counts as an edit.
  await updateTask(actor, id, { tags: [] });
  assert.deepEqual(tagList(await getTask("h1", id)), []);
  const verbs = await db.all("SELECT detail FROM activity WHERE task_id = ? AND verb = 'updated' ORDER BY created_at", [id]);
  assert.deepEqual(JSON.parse(verbs.at(-1).detail), { fields: ["tags"] });
});

test("another household's context is rejected", async () => {
  const theirs = await ensureContext("h2", "Costco");
  await assert.rejects(createTask(actor, { title: "x", contextId: theirs }), /Unknown context/);
});

test("copies (recurrence, templates) keep the context and tags", async () => {
  const id = await createTask(actor, { title: "milk", contextId: await ensureContext("h1", "Aldi"), tags: ["groceries"] });
  const copy = await getTask("h1", await copyTask(actor, await getTask("h1", id)));
  assert.equal(copy.context_name, "Aldi");
  assert.deepEqual(tagList(copy), ["groceries"]);
});

test("Google Tasks notes list the context and tags", async () => {
  const { taskToGoogle } = await import("../src/sync/mapping.js");
  const g = taskToGoogle({ id: "t1", title: "ink", notes: "", context_name: "Target", tag_names: "quick-win errand" }, { appUrl: "https://x" });
  assert.match(g.notes, /Context: Target\nTags: \+errand \+quick-win\n/);
});

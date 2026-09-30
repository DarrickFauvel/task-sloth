import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createTask, updateTask } from "../src/services/tasks.js";
import { addItems, groupItems, listItems, moveItem, setItemChecked } from "../src/services/checklist.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-checklist-order-"));
const me = { id: "u1", householdId: "h1" };

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
after(() => rmSync(dir, { recursive: true, force: true }));

const ids = async (taskId) => Object.fromEntries((await listItems(taskId)).map((i) => [i.text, i.id]));
const order = async (taskId, mode) =>
  groupItems(await listItems(taskId), mode).map((g) => [g.name, g.items.map((i) => i.text)]);

test("moving an item puts it before another, or at the end, and new items still go last", async () => {
  const task = await createTask(me, { title: "Chores" });
  await addItems(me, task, "dishes, laundry, vacuum");
  const id = await ids(task);
  await moveItem(me, id.vacuum, id.dishes);
  assert.deepEqual(await order(task), [[null, ["vacuum", "dishes", "laundry"]]]);
  await moveItem(me, id.vacuum, null);
  assert.deepEqual(await order(task), [[null, ["dishes", "laundry", "vacuum"]]]);
  await addItems(me, task, "bins");
  assert.deepEqual(await order(task), [[null, ["dishes", "laundry", "vacuum", "bins"]]]);
});

test("on a shopping list an item moves only within its section, never above a checked item", async () => {
  const task = await createTask(me, { title: "Groceries" });
  await updateTask(me, task, { listMode: "shopping" });
  await addItems(me, task, "apples, bananas, milk, cheese");
  const id = await ids(task);
  await moveItem(me, id.bananas, id.apples);
  await moveItem(me, id.cheese, id.milk);
  assert.deepEqual(await order(task, "shopping"), [["Dairy & eggs", ["cheese", "milk"]], ["Produce", ["bananas", "apples"]]]);

  await assert.rejects(moveItem(me, id.milk, id.apples), /Can't move that there/);
  await setItemChecked(me, id.apples, true);
  await assert.rejects(moveItem(me, id.bananas, id.apples), /Can't move that there/);
  await assert.rejects(moveItem({ id: "u2", householdId: "h2" }, id.milk, null), /not found/i);
});

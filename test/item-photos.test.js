import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { addItem, clearChecked, deleteItem, listItems, setItemChecked } from "../src/services/checklist.js";
import { addItemPhoto, addPhoto, listPhotos, removePhoto } from "../src/services/photos.js";
import { createTask, getTask } from "../src/services/tasks.js";
import { checklistView } from "../src/web/checklist.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-test-"));
const actor = { id: "u1", householdId: "h1" };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const realFetch = globalThis.fetch;
let uploads;
let destroyed;

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
  config.cloudinary = { cloudName: "demo", apiKey: "key", apiSecret: "secret" };
});

beforeEach(() => {
  uploads = 0;
  destroyed = [];
  globalThis.fetch = async (url, { body }) => {
    const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/upload")) return json({ public_id: `task-sloth/h1/i${++uploads}`, width: 800, height: 600 });
    destroyed.push(body.get("public_id"));
    return json({ result: "ok" });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  config.cloudinary = null;
  rmSync(dir, { recursive: true, force: true });
});

async function listWithItem(text = "oat milk") {
  const taskId = await createTask(actor, { title: "groceries", list: "todo" });
  const itemId = await addItem(actor, taskId, { text });
  return { taskId, itemId };
}

const photoOf = async (taskId, itemId) => (await listItems(taskId)).find((i) => i.id === itemId).photo_id;

test("an item's photo shows on the item, not in the task's own photos or count", async () => {
  const { taskId, itemId } = await listWithItem();
  await addPhoto(actor, taskId, JPEG);
  const id = await addItemPhoto(actor, itemId, JPEG);

  assert.equal(await photoOf(taskId, itemId), id);
  const view = await checklistView("h1", taskId);
  assert.equal(view.photosEnabled, true);
  assert.equal(view.groups[0].items[0].photo_id, id);
  assert.equal((await listPhotos("h1", taskId)).length, 1, "the gallery has only the task's photo");
  assert.equal(Number((await getTask("h1", taskId)).photo_count), 1);
});

test("a new item photo replaces the old one, which is deleted from Cloudinary", async () => {
  const { taskId, itemId } = await listWithItem();
  await addItemPhoto(actor, itemId, JPEG);
  const second = await addItemPhoto(actor, itemId, JPEG);

  assert.equal(await photoOf(taskId, itemId), second);
  assert.deepEqual(destroyed, ["task-sloth/h1/i1"]);
  const { n } = await db.get("SELECT COUNT(*) AS n FROM task_photos WHERE item_id = ?", [itemId]);
  assert.equal(Number(n), 1);
});

test("deleting an item photo leaves the item", async () => {
  const { taskId, itemId } = await listWithItem();
  const id = await addItemPhoto(actor, itemId, JPEG);
  assert.equal(await removePhoto(actor, id), taskId);
  assert.equal(await photoOf(taskId, itemId), null);
  assert.deepEqual(destroyed, ["task-sloth/h1/i1"]);
});

test("removing an item, or clearing checked items, deletes their photos too", async () => {
  const { taskId, itemId } = await listWithItem("eggs");
  const kept = await addItem(actor, taskId, { text: "bread" });
  const checked = await addItem(actor, taskId, { text: "butter" });
  await addItemPhoto(actor, itemId, JPEG); // i1
  await addItemPhoto(actor, kept, JPEG); // i2
  await addItemPhoto(actor, checked, JPEG); // i3

  await deleteItem(actor, itemId);
  assert.deepEqual(destroyed, ["task-sloth/h1/i1"]);

  await setItemChecked(actor, checked, true);
  await clearChecked(actor, taskId);
  assert.deepEqual(destroyed, ["task-sloth/h1/i1", "task-sloth/h1/i3"]);

  const left = await db.all("SELECT public_id FROM task_photos WHERE task_id = ? AND item_id IS NOT NULL", [taskId]);
  assert.deepEqual(left.map((p) => p.public_id), ["task-sloth/h1/i2"]);
});

test("only images, and only on your household's items", async () => {
  const { itemId } = await listWithItem();
  await assert.rejects(addItemPhoto(actor, itemId, Buffer.from("not an image")), /isn't a JPEG/);
  await assert.rejects(addItemPhoto({ id: "u1", householdId: "h2" }, itemId, JPEG), /not found/i);
  assert.equal(uploads, 0, "nothing rejected reached Cloudinary");
});

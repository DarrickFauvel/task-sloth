import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { addPhoto, listPhotos, purgeDeletedTaskPhotos } from "../src/services/photos.js";
import { createTask, deleteTask, listDeleted, restoreCutoff, RESTORE_DAYS, restoreTask } from "../src/services/tasks.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-test-"));
const actor = { id: "u1", householdId: "h1" };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const DAY = 86_400_000;
const realFetch = globalThis.fetch;
const quiet = { log() {}, error() {} };
let uploads;
let destroyed;
let failIds;

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  const ts = new Date().toISOString();
  await db.batch([
    { sql: "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'a@example.com', 'Alice', ?)", args: [ts] },
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', ?)", args: [ts] },
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES ('h1', 'u1', ?)", args: [ts] },
  ]);
  config.cloudinary = { cloudName: "demo", apiKey: "key", apiSecret: "secret" };
});

beforeEach(async () => {
  await db.run("DELETE FROM task_photos");
  uploads = 0;
  destroyed = [];
  failIds = new Set();
  globalThis.fetch = async (url, { body }) => {
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/upload")) return json({ public_id: `task-sloth/h1/p${++uploads}`, width: 800, height: 600 });
    const publicId = body.get("public_id");
    if (failIds.has(publicId)) return json({ error: { message: "try later" } }, 500);
    destroyed.push(publicId);
    return json({ result: "ok" });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  config.cloudinary = null;
  rmSync(dir, { recursive: true, force: true });
});

/** A task with `n` photos, deleted `daysAgo` days ago (or not deleted, if null). */
async function taskWithPhotos(n, daysAgo) {
  const taskId = await createTask(actor, { title: `task ${daysAgo}`, list: "todo" });
  for (let i = 0; i < n; i++) await addPhoto(actor, taskId, JPEG);
  if (daysAgo !== null) {
    await deleteTask(actor, taskId);
    await db.run("UPDATE tasks SET deleted_at = ? WHERE id = ?", [new Date(Date.now() - daysAgo * DAY).toISOString(), taskId]);
  }
  return taskId;
}

test("photos of tasks deleted past the restore window are removed from Cloudinary and the database", async () => {
  const old = await taskWithPhotos(2, RESTORE_DAYS + 1);
  const result = await purgeDeletedTaskPhotos({ log: quiet });

  assert.deepEqual(result, { purged: 2, failed: 0 });
  assert.deepEqual(destroyed.sort(), ["task-sloth/h1/p1", "task-sloth/h1/p2"]);
  assert.deepEqual(await listPhotos("h1", old), []);
});

test("photos of live, done and still-restorable tasks are kept", async () => {
  const live = await taskWithPhotos(1, null);
  const done = await taskWithPhotos(1, null);
  await db.run("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?", [new Date(Date.now() - 365 * DAY).toISOString(), done]);
  const recent = await taskWithPhotos(1, RESTORE_DAYS - 1);

  assert.deepEqual(await purgeDeletedTaskPhotos({ log: quiet }), { purged: 0, failed: 0 });
  assert.deepEqual(destroyed, []);
  for (const id of [live, done, recent]) assert.equal((await listPhotos("h1", id)).length, 1);

  // The cutoff is the same one Recently deleted uses: a task it still offers keeps its photos.
  assert.ok((await listDeleted("h1")).some((t) => t.id === recent));
  await restoreTask(actor, recent);
  assert.equal((await listPhotos("h1", recent)).length, 1, "a restored task has its photos");
});

test("a photo whose delete fails keeps its row, and the next run retries it", async () => {
  const old = await taskWithPhotos(2, RESTORE_DAYS + 5);
  failIds.add("task-sloth/h1/p1");

  assert.deepEqual(await purgeDeletedTaskPhotos({ log: quiet }), { purged: 1, failed: 1 });
  assert.deepEqual((await listPhotos("h1", old)).map((p) => p.public_id), ["task-sloth/h1/p1"]);

  failIds.clear();
  assert.deepEqual(await purgeDeletedTaskPhotos({ log: quiet }), { purged: 1, failed: 0 });
  assert.deepEqual(await listPhotos("h1", old), []);
});

test("a run takes at most `limit` photos, oldest deletions first", async () => {
  const older = await taskWithPhotos(2, RESTORE_DAYS + 10);
  const newer = await taskWithPhotos(1, RESTORE_DAYS + 2);

  assert.deepEqual(await purgeDeletedTaskPhotos({ limit: 2, log: quiet }), { purged: 2, failed: 0 });
  assert.deepEqual(await listPhotos("h1", older), []);
  assert.equal((await listPhotos("h1", newer)).length, 1);
});

test("restoreCutoff is RESTORE_DAYS before now", () => {
  const nowMs = Date.parse("2026-10-01T12:00:00.000Z");
  assert.equal(restoreCutoff(nowMs), new Date(nowMs - RESTORE_DAYS * DAY).toISOString());
});

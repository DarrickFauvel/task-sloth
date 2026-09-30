import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createHash } from "node:crypto";
import { sign, signedImageUrl } from "../src/lib/cloudinary.js";
import { addPhoto, listPhotos, removePhoto } from "../src/services/photos.js";
import { createTask, getTask } from "../src/services/tasks.js";
import { taskPhotosView } from "../src/web/task-photos.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-test-"));
const actor = { id: "u1", householdId: "h1" };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const realFetch = globalThis.fetch;
let calls;

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
  calls = [];
  globalThis.fetch = async (url, { body }) => {
    calls.push({ url, params: Object.fromEntries([...body.entries()].filter(([k]) => k !== "file")) });
    const ok = { public_id: `task-sloth/h1/p${calls.length}`, width: 800, height: 600, result: "ok" };
    return new Response(JSON.stringify(ok), { status: 200, headers: { "Content-Type": "application/json" } });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  config.cloudinary = null;
  rmSync(dir, { recursive: true, force: true });
});

test("sign matches Cloudinary's documented example", () => {
  const params = { eager: "w_400,h_300,c_pad|w_260,h_200,c_crop", public_id: "sample_image", timestamp: 1315060510 };
  assert.equal(sign(params, "abcd"), "bfd09f95f331f558cbd1320e67aa8d488770583e");
});

test("signedImageUrl signs the transform and public id for a private image", () => {
  const path = "c_fill,w_10,h_10,f_auto,q_auto/a/b";
  const sig = createHash("sha1").update(`${path}secret`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").slice(0, 8);
  assert.equal(signedImageUrl("a/b", "c_fill,w_10,h_10"), `https://res.cloudinary.com/demo/image/authenticated/s--${sig}--/${path}`);
});

test("a photo uploads to the household's folder, shows on the task, and deletes from Cloudinary", async () => {
  const taskId = await createTask(actor, { title: "fix fence", list: "todo" });
  const id = await addPhoto(actor, taskId, JPEG);

  assert.match(calls[0].url, /\/v1_1\/demo\/image\/upload$/);
  assert.equal(calls[0].params.folder, "task-sloth/h1");
  assert.equal(calls[0].params.type, "authenticated", "stored private");
  assert.equal(calls[0].params.api_key, "key");
  const { signature, api_key, ...signed } = calls[0].params;
  assert.equal(signature, sign(signed, "secret"));

  assert.equal(Number((await getTask("h1", taskId)).photo_count), 1);
  const view = await taskPhotosView("h1", taskId);
  assert.equal(view.photos[0].id, id);
  assert.equal(view.photos[0].thumb, `/photos/${id}/thumb`, "served by the app, not a Cloudinary link");
  assert.equal(view.photos[0].full, `/photos/${id}/full`);

  assert.equal(await removePhoto(actor, id), taskId);
  assert.match(calls[1].url, /\/image\/destroy$/);
  assert.equal(calls[1].params.public_id, "task-sloth/h1/p1");
  assert.equal(calls[1].params.type, "authenticated");
  assert.deepEqual(await listPhotos("h1", taskId), []);
});

test("a task row carries its first three photos, oldest first", async () => {
  const taskId = await createTask(actor, { title: "garden", list: "todo" });
  const ids = [];
  for (let i = 0; i < 4; i++) {
    ids.push(await addPhoto(actor, taskId, JPEG));
    // Distinct times: two photos in the same millisecond would fall back to (random) id order.
    await db.run("UPDATE task_photos SET created_at = ? WHERE id = ?", [`2026-09-30T12:00:0${i}.000Z`, ids[i]]);
  }
  const task = await getTask("h1", taskId);
  assert.equal(Number(task.photo_count), 4);
  assert.deepEqual(JSON.parse(task.photo_ids), ids.slice(0, 3));
});

test("only images, and only on your household's tasks", async () => {
  const taskId = await createTask(actor, { title: "paint", list: "todo" });
  await assert.rejects(addPhoto(actor, taskId, Buffer.from("not an image")), /isn't a JPEG/);
  await assert.rejects(addPhoto({ id: "u1", householdId: "h2" }, taskId, JPEG), /not found/i);
  const id = await addPhoto(actor, taskId, JPEG);
  await assert.rejects(removePhoto({ id: "u1", householdId: "h2" }, id), /not found/i);
  assert.equal(calls.length, 1, "nothing rejected reached Cloudinary");
});

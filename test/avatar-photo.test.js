import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { acceptInvite, createHousehold, createInvite, getHouseholdForUser } from "../src/services/household.js";
import { getAvatarPhoto, getUser, imageType, removeAvatarPhoto, setAvatarPhoto, updateName } from "../src/services/users.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-avatar-"));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  const ts = new Date().toISOString();
  await db.run(
    "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'a@x.com', 'Alice', ?), ('u2', 'b@x.com', 'Bob', ?), ('u3', 'c@x.com', 'Cat', ?)",
    [ts, ts, ts],
  );
  await acceptInvite(await createInvite(await createHousehold("u1", "Home"), "u1"), "u2");
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("imageType knows JPEG, PNG and WebP by their bytes, and nothing else", () => {
  assert.equal(imageType(JPEG), "image/jpeg");
  assert.equal(imageType(Buffer.from("89504e470d0a1a0a0000", "hex")), "image/png");
  assert.equal(imageType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")), "image/webp");
  assert.equal(imageType(Buffer.from("<svg onload=alert(1)>")), null);
  assert.equal(imageType(Buffer.alloc(0)), null);
});

test("a saved photo shows to you and your housemates, not to strangers, until you remove it", async () => {
  await assert.rejects(setAvatarPhoto("u1", Buffer.from("GIF89a....")), /isn't a JPEG/);
  await setAvatarPhoto("u1", JPEG);
  assert.ok((await getUser("u1")).avatar_photo_at);
  assert.ok((await getHouseholdForUser("u2")).members.find((m) => m.id === "u1").avatar_photo_at);

  assert.deepEqual((await getAvatarPhoto("u1", "u1")).image, JPEG);
  assert.equal((await getAvatarPhoto("u2", "u1")).type, "image/jpeg");
  assert.equal(await getAvatarPhoto("u3", "u1"), undefined);

  await setAvatarPhoto("u1", Buffer.from("89504e470d0a1a0a0000", "hex")); // replacing keeps one row
  assert.equal((await getAvatarPhoto("u1", "u1")).type, "image/png");

  await removeAvatarPhoto("u1");
  assert.equal((await getUser("u1")).avatar_photo_at, null);
  assert.equal(await getAvatarPhoto("u1", "u1"), undefined);
});

test("updateName tidies spaces, returns the saved name, and won't take a blank one", async () => {
  assert.equal(await updateName("u1", "  Sam   Smith "), "Sam Smith");
  assert.equal((await getUser("u1")).name, "Sam Smith");
  await assert.rejects(updateName("u1", "   "), /can't be empty/);
  assert.equal((await getUser("u1")).name, "Sam Smith");
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { acceptInvite, createHousehold, createInvite, getHouseholdForUser, renameHousehold } from "../src/services/household.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-household-"));

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  const ts = new Date().toISOString();
  await db.run(
    "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'a@x.com', 'Alice', ?), ('u2', 'b@x.com', 'Bob', ?), ('u3', 'c@x.com', 'Cat', ?)",
    [ts, ts, ts],
  );
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("whoever set up the household owns it, and only they can rename it", async () => {
  const id = await createHousehold("u1", "Our place");
  await new Promise((r) => setTimeout(r, 5)); // joined_at is a timestamp: make Bob clearly later
  await acceptInvite(await createInvite(id, "u1"), "u2");
  assert.equal((await getHouseholdForUser("u2")).ownerId, "u1");

  await assert.rejects(renameHousehold("u2", "Bob's place"), /Only the person who set up/);
  await assert.rejects(renameHousehold("u1", "   "), /needs a name/);
  await assert.rejects(renameHousehold("u3", "Nope"), /not in a household/);
  assert.equal(await renameHousehold("u1", "  The   Burrow "), id);
  assert.equal((await getHouseholdForUser("u2")).household.name, "The Burrow");
});

test("new members get one of the seven member colors", async () => {
  const { members } = await getHouseholdForUser("u1");
  const { MEMBER_COLORS } = await import("../src/services/users.js");
  for (const m of members) assert.ok(MEMBER_COLORS.includes(m.color), m.color);
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb, now } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { MEMBER_COLORS, MEMBER_COLOR_NAMES, upsertDevUser } from "../src/services/users.js";
import { PROJECT_COLORS } from "../src/services/projects.js";

const OLD = ["#6d5dfc", "#e0527a", "#1f9d8b", "#e38b1b", "#3a86ff", "#8d6e63", "#7cb342"];
let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "sloth-forest-"));
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("every member color has a name, and projects share the palette", () => {
  assert.equal(MEMBER_COLORS.length, OLD.length);
  for (const c of MEMBER_COLORS) assert.ok(MEMBER_COLOR_NAMES[c], c);
  assert.deepEqual(PROJECT_COLORS, MEMBER_COLORS);
});

test("migration 019 moves each old color to the forest color in the same place", async () => {
  await db.run("INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', ?)", [now()]);
  for (const [i, color] of [...OLD, "#123456"].entries()) {
    await db.run("INSERT INTO users (id, email, name, color, created_at) VALUES (?, ?, ?, ?, ?)", [`u${i}`, `u${i}@x.test`, `U${i}`, color, now()]);
    await db.run("INSERT INTO projects (id, household_id, name, color, created_at, updated_at) VALUES (?, 'h1', ?, ?, ?, ?)", [`p${i}`, `P${i}`, color, now(), now()]);
  }
  await db.run("DELETE FROM schema_migrations WHERE name = '019_forest_colors.sql'");
  await migrate({ log: () => {} });

  const users = await db.all("SELECT color FROM users WHERE id LIKE 'u%' ORDER BY id");
  const projects = await db.all("SELECT color FROM projects ORDER BY id");
  const expected = [...MEMBER_COLORS, "#123456"];
  assert.deepEqual(users.map((r) => r.color), expected);
  assert.deepEqual(projects.map((r) => r.color), expected);
});

test("new users start with the first forest color", async () => {
  const id = await upsertDevUser("fern");
  assert.equal((await db.get("SELECT color FROM users WHERE id = ?", [id])).color, MEMBER_COLORS[0]);
});

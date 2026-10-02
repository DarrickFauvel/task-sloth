import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { db, getClient, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-test-"));
const migrations = fileURLToPath(new URL("../migrations/", import.meta.url));
after(() => rmSync(dir, { recursive: true, force: true }));

// 013 runs on databases where people already put where/hows on the map with 012's single place.
test("migration 013 moves each where/how's place into its spots, then drops the old columns", async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  const client = getClient();
  await client.execute("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql") && f < "013").sort()) {
    await client.executeMultiple(readFileSync(join(migrations, file), "utf8"));
    await client.execute({ sql: "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", args: [file, "2026-10-02"] });
  }
  const ts = "2026-10-02T00:00:00.000Z";
  await db.batch([
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', ?)", args: [ts] },
    { sql: "INSERT INTO contexts (id, household_id, name, created_at, place_lat, place_lng, place_label) VALUES ('c1', 'h1', 'Target', ?, 40.1, -75.2, 'Target, Main Street')", args: [ts] },
    { sql: "INSERT INTO contexts (id, household_id, name, created_at, place_lat, place_lng) VALUES ('c2', 'h1', 'Mall', ?, 41, -74)", args: [ts] },
    { sql: "INSERT INTO contexts (id, household_id, name, created_at) VALUES ('c3', 'h1', 'Phone', ?)", args: [ts] },
  ]);

  await migrate({ log: () => {} });

  const spots = await db.all("SELECT context_id, lat, lng, label FROM context_spots ORDER BY context_id");
  assert.deepEqual(spots, [
    { context_id: "c1", lat: 40.1, lng: -75.2, label: "Target, Main Street" },
    { context_id: "c2", lat: 41, lng: -74, label: null },
  ]);
  const columns = (await db.all("PRAGMA table_info(contexts)")).map((c) => c.name);
  assert.ok(!columns.some((c) => c.startsWith("place_")), `old columns gone: ${columns}`);
});

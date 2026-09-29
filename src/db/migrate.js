import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { getClient, initDb } from "./client.js";

const migrationsDir = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** Applies any migrations in /migrations that haven't run yet, in filename order. */
export async function migrate({ log = console.log } = {}) {
  const client = getClient();
  await client.execute(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (await client.execute("SELECT name FROM schema_migrations")).rows.map((r) => r[0]),
  );
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), "utf8");
    await client.executeMultiple(sql);
    await client.execute({
      sql: "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
      args: [file, new Date().toISOString()],
    });
    log(`migrated ${file}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { config } = await import("../config.js");
  initDb(config.db);
  await migrate();
}

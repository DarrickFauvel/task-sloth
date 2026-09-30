import { db, newId, now } from "../db/client.js";
import { HttpError } from "../lib/http.js";

export async function listContexts(householdId) {
  return db.all(
    `SELECT cx.*,
            (SELECT COUNT(*) FROM tasks t
              WHERE t.context_id = cx.id AND t.deleted_at IS NULL AND t.is_template = 0 AND t.status = 'open') AS open_count
       FROM contexts cx WHERE cx.household_id = ? ORDER BY cx.name COLLATE NOCASE`,
    [householdId],
  );
}

export async function getContext(householdId, id) {
  const context = await db.get("SELECT * FROM contexts WHERE id = ? AND household_id = ?", [id, householdId]);
  if (!context) throw new HttpError(404, "Context not found");
  return context;
}

/**
 * Returns the id of the household's context with this name (any case), creating it if needed.
 * New contexts get each word capitalised: "home depot" -> "Home Depot" (and "IKEA" stays "IKEA").
 */
export async function ensureContext(householdId, name) {
  name = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 80).replace(/(^|\s)(\p{L})/gu, (_, s, c) => s + c.toUpperCase());
  if (!name) throw new HttpError(400, "Context needs a name");
  await db.run(
    "INSERT INTO contexts (id, household_id, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    [newId(), householdId, name, now()],
  );
  const row = await db.get("SELECT id FROM contexts WHERE household_id = ? AND name = ? COLLATE NOCASE", [householdId, name]);
  return row.id;
}

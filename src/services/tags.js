import { db, newId, now } from "../db/client.js";

/** "Quick Win" or "+quick_win" -> "quick-win". Empty when nothing usable is left. */
export const cleanTagName = (name) =>
  String(name ?? "")
    .toLowerCase()
    .replace(/^\+/, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

/** Splits what's typed in the edit form ("errand, +quick-win shop") into clean, distinct tag names. */
export const parseTagList = (text) => [...new Set(String(text ?? "").split(/[\s,]+/).map(cleanTagName).filter(Boolean))];

export async function listTags(householdId) {
  return db.all(
    `SELECT g.*,
            (SELECT COUNT(*) FROM task_tags tt JOIN tasks t ON t.id = tt.task_id
              WHERE tt.tag_id = g.id AND t.deleted_at IS NULL AND t.is_template = 0 AND t.status = 'open') AS open_count
       FROM tags g WHERE g.household_id = ? ORDER BY g.name`,
    [householdId],
  );
}

/** Returns the ids of the household's tags with these names, creating any that don't exist yet. */
export async function ensureTags(householdId, names) {
  names = [...new Set(names.map(cleanTagName).filter(Boolean))];
  if (!names.length) return [];
  const ts = now();
  await db.batch(
    names.map((name) => ({
      sql: "INSERT INTO tags (id, household_id, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
      args: [newId(), householdId, name, ts],
    })),
  );
  const rows = await db.all(
    `SELECT id FROM tags WHERE household_id = ? AND name IN (${names.map(() => "?").join(", ")})`,
    [householdId, ...names],
  );
  return rows.map((r) => r.id);
}

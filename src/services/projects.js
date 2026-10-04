import { db, newId, now } from "../db/client.js";
import { HttpError } from "../lib/http.js";

export const PROJECT_COLORS = ["#5b8a3c", "#b04a6b", "#2f8f6b", "#c0693b", "#3c7fa6", "#8a6a4f", "#7a68b5"];

export async function listProjects(householdId, { includeArchived = false } = {}) {
  return db.all(
    `SELECT p.*,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.is_template = 0) AS task_count,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.is_template = 0 AND t.status = 'done') AS done_count
       FROM projects p WHERE p.household_id = ? ${includeArchived ? "" : "AND p.archived = 0"}
      ORDER BY p.archived, p.name COLLATE NOCASE`,
    [householdId],
  );
}

/** A project's name and how many of its tasks are done, or null; for milestones when a task is finished. */
export async function projectProgress(householdId, id) {
  const row = await db.get(
    `SELECT p.name, p.emoji,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.is_template = 0) AS total,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.is_template = 0 AND t.status = 'done') AS done
       FROM projects p WHERE p.id = ? AND p.household_id = ?`,
    [id, householdId],
  );
  return row ? { name: `${row.emoji} ${row.name}`, done: Number(row.done), total: Number(row.total) } : null;
}

export async function getProject(householdId, id) {
  const project = await db.get("SELECT * FROM projects WHERE id = ? AND household_id = ?", [id, householdId]);
  if (!project) throw new HttpError(404, "Project not found");
  return project;
}

export async function createProject(householdId, { name, emoji, color }) {
  name = String(name ?? "").trim().slice(0, 80);
  if (!name) throw new HttpError(400, "Project needs a name");
  const existing = await db.get(
    "SELECT id FROM projects WHERE household_id = ? AND name = ? COLLATE NOCASE AND archived = 0",
    [householdId, name],
  );
  if (existing) return existing.id;
  const id = newId();
  const { n } = await db.get("SELECT COUNT(*) AS n FROM projects WHERE household_id = ?", [householdId]);
  await db.run(
    "INSERT INTO projects (id, household_id, name, emoji, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, householdId, name, emoji?.trim() || "📁", PROJECT_COLORS.includes(color) ? color : PROJECT_COLORS[Number(n) % PROJECT_COLORS.length], now(), now()],
  );
  return id;
}

export async function updateProject(householdId, id, { name, emoji, color, archived }) {
  const p = await getProject(householdId, id);
  await db.run(
    "UPDATE projects SET name = ?, emoji = ?, color = ?, archived = ?, updated_at = ? WHERE id = ?",
    [
      String(name ?? p.name).trim().slice(0, 80) || p.name,
      emoji?.trim() || p.emoji,
      PROJECT_COLORS.includes(color) ? color : p.color,
      archived === undefined ? p.archived : archived ? 1 : 0,
      now(),
      id,
    ],
  );
}

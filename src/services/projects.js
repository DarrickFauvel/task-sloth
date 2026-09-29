import { db, newId, now } from "../db/client.js";
import { HttpError } from "../lib/http.js";

export const PROJECT_COLORS = ["#6d5dfc", "#e0527a", "#1f9d8b", "#e38b1b", "#3a86ff", "#8d6e63", "#7cb342"];

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

import { db, newId, now } from "../db/client.js";
import { HttpError } from "../lib/http.js";
import { changed } from "./changes.js";

export const PROJECT_COLORS = ["#5b8a3c", "#b04a6b", "#2f8f6b", "#c0693b", "#3c7fa6", "#8a6a4f", "#7a68b5"];

/**
 * Logos a project can show in place of its emoji: the key stored in projects.icon, then its name and file. They're
 * bundled (public/img/project-icons/), never fetched. selfh.st icons are CC BY 4.0, credited on the About page.
 */
export const PROJECT_ICONS = {
  ebay: { label: "eBay", src: "/img/project-icons/ebay.svg" },
};

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

export async function updateProject(householdId, id, { name, emoji, color, icon, archived }) {
  const p = await getProject(householdId, id);
  const newName = String(name ?? p.name).trim().slice(0, 80) || p.name;
  // Typed #names pick a project by name, so two open ones can't share one.
  const clash = await db.get(
    "SELECT id FROM projects WHERE household_id = ? AND name = ? COLLATE NOCASE AND archived = 0 AND id <> ?",
    [householdId, newName, id],
  );
  if (clash) throw new HttpError(400, `There's already a project called “${newName}”`);
  await db.run(
    "UPDATE projects SET name = ?, emoji = ?, color = ?, icon = ?, archived = ?, updated_at = ? WHERE id = ?",
    [
      newName,
      String(emoji ?? "").trim().slice(0, 16) || p.emoji,
      PROJECT_COLORS.includes(color) ? color : p.color,
      // "" picks no logo; a key that isn't one of PROJECT_ICONS (or leaving it out) keeps the one it has.
      icon === "" ? null : Object.hasOwn(PROJECT_ICONS, icon ?? "") ? icon : p.icon,
      archived === undefined ? p.archived : archived ? 1 : 0,
      now(),
      id,
    ],
  );
  changed(householdId);
}

/**
 * Removes a project. It's archived rather than deleted, since finished tasks and Claude's check-ins still point at
 * it; its open tasks stay on their lists, just without a project. Typing its name again starts a new one.
 */
export async function removeProject(householdId, id) {
  const p = await getProject(householdId, id);
  const ts = now();
  await db.batch([
    { sql: "UPDATE tasks SET project_id = NULL, updated_at = ? WHERE household_id = ? AND project_id = ? AND status <> 'done'", args: [ts, householdId, id] },
    { sql: "UPDATE projects SET archived = 1, updated_at = ? WHERE id = ?", args: [ts, id] },
  ]);
  changed(householdId);
  return p;
}

/** Removes every open project with no tasks at all and no goal (one with a goal may be waiting on Claude's plan). */
export async function removeEmptyProjects(householdId) {
  const result = await db.run(
    `UPDATE projects SET archived = 1, updated_at = ?
      WHERE household_id = ? AND archived = 0 AND goal IS NULL
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = projects.id AND t.deleted_at IS NULL)`,
    [now(), householdId],
  );
  if (result.rowsAffected) changed(householdId);
  return result.rowsAffected;
}

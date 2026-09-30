import { db, newId, now } from "../db/client.js";

/**
 * Records something that happened. `actorId` is null when the change came from Google.
 * Returns a statement so callers can include it in a batch.
 */
export function activityStatement(householdId, actorId, taskId, verb, detail = null) {
  return {
    sql: "INSERT INTO activity (id, household_id, actor_id, task_id, verb, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [newId(), householdId, actorId, taskId, verb, detail ? JSON.stringify(detail) : null, now()],
  };
}

export async function logActivity(...args) {
  const { sql, args: values } = activityStatement(...args);
  await db.run(sql, values);
}

/** Newest first. `since` (an ISO time) leaves out anything older. */
export async function listActivity(householdId, { taskId, since, limit = 50 } = {}) {
  const where = ["a.household_id = ?"];
  const args = [householdId];
  if (taskId) (where.push("a.task_id = ?"), args.push(taskId));
  if (since) (where.push("a.created_at >= ?"), args.push(since));
  const rows = await db.all(
    `SELECT a.*, t.title AS task_title, t.deleted_at AS task_deleted_at
       FROM activity a LEFT JOIN tasks t ON t.id = a.task_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.created_at DESC LIMIT ?`,
    [...args, limit],
  );
  return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : {} }));
}

/** Human sentence for an activity row, e.g. "Sam reassigned “Groceries” to you". */
export function describeActivity(a, { membersById, meId }) {
  const who = (id) => (id === meId ? "you" : (membersById[id]?.name.split(" ")[0] ?? "someone"));
  const actor = a.actor_id ? who(a.actor_id).replace(/^you$/, "You") : "Google Tasks";
  const d = a.detail ?? {};
  switch (a.verb) {
    case "created": return `${actor} added`;
    case "completed": return `${actor} completed`;
    case "reopened": return `${actor} reopened`;
    case "assigned":
      if (!d.to) return `${actor} put up for grabs`;
      if (d.to === a.actor_id) return `${actor} claimed`;
      return `${actor} assigned to ${who(d.to)}`;
    case "updated": return `${actor} edited`;
    case "deleted": return `${actor} deleted`;
    case "restored": return `${actor} restored`;
    case "commented": return `${actor} commented on`;
    case "checklist": return `${actor} added ${d.count} item${d.count === 1 ? "" : "s"} to`;
    case "recurred": return `Next occurrence scheduled for`;
    case "unblocked": return `Ready to go:`;
    case "snoozed": return `${actor} snoozed`;
    default: return `${actor} ${a.verb}`;
  }
}

import { db } from "../db/client.js";
import { logActivity } from "./activity.js";

// The weekly reset: each person's step-by-step check-in (see src/web/reset-page.js). Finishing one is an activity
// row ("Sam did their weekly reset"), which is also where the last one is read from, so it needs no table.

/** How long after a reset (or after joining, before the first) Mine starts suggesting the next one. */
export const RESET_EVERY_MS = 7 * 86_400_000;

/** When this person last finished a weekly reset (an ISO time), or null. */
export async function lastResetAt(householdId, userId) {
  const row = await db.get("SELECT MAX(created_at) AS at FROM activity WHERE household_id = ? AND actor_id = ? AND verb = 'reset'", [householdId, userId]);
  return row?.at ?? null;
}

/** "Not now" on Mine's reset card, per person: until when it stays hidden. Kept in memory, like hidden-done. */
const snoozedUntil = new Map();
export const SNOOZE_MS = 86_400_000;
export function snoozeReset(userId, now = Date.now()) {
  snoozedUntil.set(userId, now + SNOOZE_MS);
}

/**
 * Whether Mine should suggest a reset: a week since the last one, or since joining if there hasn't been one,
 * unless "Not now" was tapped in the last day.
 */
export async function resetDue(householdId, member, now = Date.now()) {
  if ((snoozedUntil.get(member.id) ?? 0) > now) return false;
  const since = (await lastResetAt(householdId, member.id)) ?? member.joined_at;
  return Boolean(since) && now - Date.parse(since) >= RESET_EVERY_MS;
}

/**
 * What this person did to their tasks since `since` (when the reset started), for its last screen:
 * tasks finished, tasks changed some other way (sorted, moved, claimed…), and tasks deleted (and not restored).
 */
export async function resetSummary(householdId, userId, since) {
  const rows = await db.all(
    "SELECT verb, task_id FROM activity WHERE household_id = ? AND actor_id = ? AND created_at >= ? AND task_id IS NOT NULL ORDER BY created_at",
    [householdId, userId, since],
  );
  const finished = new Set(), changed = new Set(), deleted = new Set();
  for (const { verb, task_id: id } of rows) {
    if (verb === "completed") finished.add(id);
    else if (verb === "reopened") finished.delete(id);
    else if (verb === "deleted") deleted.add(id);
    else if (verb === "restored") deleted.delete(id);
    else changed.add(id);
  }
  for (const id of [...finished, ...deleted]) changed.delete(id);
  return { finished: finished.size, changed: changed.size, deleted: deleted.size };
}

/** Finishing a reset: one activity row, with what it got done. */
export async function recordReset(actor, summary) {
  await logActivity(actor.householdId, actor.id, null, "reset", summary);
}

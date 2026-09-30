// Finished tasks someone has hidden from their lists before they'd drop off on their own (LINGER_MS).
// In memory, per user: it only matters for a few minutes, and a single instance serves everyone
// (see src/lib/pubsub.js). A restart just brings a hidden task back until its time is up.

/** @type {Map<string, Map<string, { completedAt: string, until: number }>>} userId -> taskId -> hide */
const hidden = new Map();

/** Hides this completion of the task (reopening and finishing it again shows it again) until `until` (ms). */
export function hideDone(userId, taskId, completedAt, until) {
  if (!hidden.has(userId)) hidden.set(userId, new Map());
  hidden.get(userId).set(taskId, { completedAt, until });
}

/** Whether this user hid the task's current completion. */
export function isHiddenDone(userId, task, now = Date.now()) {
  const tasks = hidden.get(userId);
  if (!tasks) return false;
  for (const [id, { until }] of tasks) if (until <= now) tasks.delete(id);
  if (!tasks.size) hidden.delete(userId);
  return tasks.get(task.id)?.completedAt === task.completed_at;
}

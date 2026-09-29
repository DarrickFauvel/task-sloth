// Fan-out for "a task changed": the Google sync queue and live browser updates both
// subscribe here, so services don't need to know about either.

/** @type {((change: { householdId: string, taskId?: string, fromGoogle?: boolean }) => void)[]} */
const listeners = [];

export function onChange(fn) {
  listeners.push(fn);
}

export function changed(householdId, taskId, { fromGoogle = false } = {}) {
  for (const fn of listeners) {
    try {
      fn({ householdId, taskId, fromGoogle });
    } catch (err) {
      console.error("change listener failed", err);
    }
  }
}

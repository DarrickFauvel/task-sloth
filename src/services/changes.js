// Fan-out for "a task changed": the Google sync queue and live browser updates both
// subscribe here, so services don't need to know about either.

/** @type {((change: { householdId: string, taskId?: string, fromGoogle?: boolean, editedBy?: string | null }) => void)[]} */
const listeners = [];

// When each household last changed (ms), so a live stream can tell whether the page it's attached to is
// already current. Before any change since the server started, that's the start: a page from before a
// restart might have missed something.
const startedAt = Date.now();
/** @type {Map<string, number>} */
const changedAt = new Map();
export const lastChangedAt = (householdId) => changedAt.get(householdId) ?? startedAt;

export function onChange(fn) {
  listeners.push(fn);
}

/** `editedBy` is the member who changed the task's details (updateTask), for an open edit form's notice. */
export function changed(householdId, taskId, { fromGoogle = false, editedBy = null } = {}) {
  changedAt.set(householdId, Date.now());
  for (const fn of listeners) {
    try {
      fn({ householdId, taskId, fromGoogle, editedBy });
    } catch (err) {
      console.error("change listener failed", err);
    }
  }
}

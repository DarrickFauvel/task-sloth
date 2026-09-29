// In-process pub/sub keyed by household. Railway runs a single instance, so this is
// enough for live updates; running several instances would need Redis or similar.

/** @type {Map<string, Set<(event: object) => void>>} */
const channels = new Map();

export function subscribe(householdId, fn) {
  if (!channels.has(householdId)) channels.set(householdId, new Set());
  channels.get(householdId).add(fn);
  return () => {
    const set = channels.get(householdId);
    set?.delete(fn);
    if (set?.size === 0) channels.delete(householdId);
  };
}

export function publish(householdId, event = { type: "changed" }) {
  for (const fn of channels.get(householdId) ?? []) {
    try {
      fn(event);
    } catch (err) {
      console.error("pubsub listener failed", err);
    }
  }
}

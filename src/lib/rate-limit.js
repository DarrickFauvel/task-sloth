// Fixed-window attempt counter, in memory. Like pubsub.js, that's enough for a single
// instance; several instances would each keep their own counts.

export function createRateLimit({ limit, windowMs, now = Date.now }) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const hits = new Map();
  const current = (key) => {
    const h = hits.get(key);
    return h && h.resetAt > now() ? h : null;
  };
  return {
    /** True once `key` has used up its attempts for the current window. */
    isLimited(key) {
      return (current(key)?.count ?? 0) >= limit;
    },
    /** Records an attempt against `key`. */
    hit(key) {
      const t = now();
      const h = current(key) ?? { count: 0, resetAt: t + windowMs };
      h.count++;
      hits.set(key, h);
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

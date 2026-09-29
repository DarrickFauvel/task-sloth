/**
 * Minimal router: `router.get("/tasks/:id", handler)`.
 * Handlers receive a context object; see server.js for what's on it.
 */
export function createRouter() {
  /** @type {{ method: string, re: RegExp, keys: string[], handler: Function, opts: object }[]} */
  const routes = [];
  const add = (method) => (path, handler, opts = {}) => {
    const keys = [];
    const pattern = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\/:(\w+)/g, (_, key) => {
      keys.push(key);
      return "/([^/]+)";
    });
    routes.push({ method, re: new RegExp(`^${pattern}/?$`), keys, handler, opts });
  };
  return {
    get: add("GET"),
    post: add("POST"),
    /** @returns {{ handler: Function, params: Record<string,string>, opts: object } | { methodNotAllowed: true } | null} */
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method && !(method === "HEAD" && r.method === "GET")) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return { handler: r.handler, params, opts: r.opts };
      }
      return pathMatched ? { methodNotAllowed: true } : null;
    },
  };
}

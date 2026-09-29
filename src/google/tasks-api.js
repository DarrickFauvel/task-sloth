// Thin wrapper over the Google Tasks REST API (v1) using fetch.
// https://developers.google.com/tasks/reference/rest

const BASE = "https://tasks.googleapis.com/tasks/v1";

export class GoogleApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{ getAccessToken: (userId: string, opts?: { force?: boolean }) => Promise<string>, fetchImpl?: typeof fetch }} deps
 */
export function createTasksApi({ getAccessToken, fetchImpl = fetch }) {
  async function call(userId, method, path, { query, body } = {}, retried = false) {
    const token = await getAccessToken(userId, { force: retried });
    const url = `${BASE}${path}${query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v != null))}` : ""}`;
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) return call(userId, method, path, { query, body }, true);
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new GoogleApiError(res.status, data?.error?.message ?? `Google Tasks ${method} ${path} failed (${res.status})`);
    return data;
  }

  const enc = encodeURIComponent;
  return {
    listLists: (userId) => call(userId, "GET", "/users/@me/lists", { query: { maxResults: 100 } }),
    insertList: (userId, title) => call(userId, "POST", "/users/@me/lists", { body: { title } }),
    /** One page of tasks; pass pageToken from the previous result to continue. */
    listTasks: (userId, listId, { updatedMin, pageToken } = {}) =>
      call(userId, "GET", `/lists/${enc(listId)}/tasks`, {
        query: { updatedMin, pageToken, maxResults: 100, showCompleted: true, showHidden: true, showDeleted: true },
      }),
    insertTask: (userId, listId, body, { parent, previous } = {}) =>
      call(userId, "POST", `/lists/${enc(listId)}/tasks`, { body, query: { parent, previous } }),
    patchTask: (userId, listId, taskId, body) => call(userId, "PATCH", `/lists/${enc(listId)}/tasks/${enc(taskId)}`, { body }),
    deleteTask: (userId, listId, taskId) => call(userId, "DELETE", `/lists/${enc(listId)}/tasks/${enc(taskId)}`),
  };
}

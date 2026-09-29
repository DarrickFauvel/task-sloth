import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/** @type {import("@libsql/client").Client | null} */
let client = null;

/**
 * Connects to Turso (libsql://…), a local SQLite file (file:…) or memory (:memory:).
 * @param {{ url: string, authToken?: string }} opts
 */
export function initDb({ url, authToken }) {
  if (url.startsWith("file:") && !url.includes(":memory:")) {
    mkdirSync(dirname(url.slice("file:".length)), { recursive: true });
  }
  client = createClient({ url, authToken });
  return client;
}

export function getClient() {
  if (!client) throw new Error("Database not initialised; call initDb() first");
  return client;
}

/** Converts libsql rows into plain objects. */
function toObjects(result) {
  return result.rows.map((row) => Object.fromEntries(result.columns.map((c, i) => [c, row[i]])));
}

export const db = {
  /** @returns {Promise<Record<string, any>[]>} */
  async all(sql, args = []) {
    return toObjects(await getClient().execute({ sql, args }));
  },
  /** @returns {Promise<Record<string, any> | undefined>} */
  async get(sql, args = []) {
    return (await db.all(sql, args))[0];
  },
  async run(sql, args = []) {
    return getClient().execute({ sql, args });
  },
  /** Runs statements atomically. @param {{sql: string, args?: any[]}[]} statements */
  async batch(statements) {
    return getClient().batch(statements.map((s) => ({ sql: s.sql, args: s.args ?? [] })), "write");
  },
};

export const newId = () => randomBytes(12).toString("base64url");
export const now = () => new Date().toISOString();

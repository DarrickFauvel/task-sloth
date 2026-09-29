import { db, newId, now } from "../db/client.js";
import { encrypt } from "../lib/crypto.js";

export const getUser = (id) => db.get("SELECT * FROM users WHERE id = ?", [id]);

/** Creates or updates a user from their Google profile and stores their (encrypted) tokens. */
export async function upsertGoogleUser(profile, tokens) {
  const existing = await db.get("SELECT * FROM users WHERE google_sub = ?", [profile.sub]);
  const expires = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString();
  const refresh = tokens.refresh_token ? encrypt(tokens.refresh_token) : existing?.google_refresh_token ?? null;
  if (existing) {
    await db.run(
      `UPDATE users SET email = ?, name = ?, avatar_url = ?, google_refresh_token = ?, google_access_token = ?,
              google_token_expires_at = ?, google_sync_error = NULL WHERE id = ?`,
      [profile.email, profile.name ?? profile.email, profile.picture ?? null, refresh, encrypt(tokens.access_token), expires, existing.id],
    );
    return existing.id;
  }
  const id = newId();
  await db.run(
    `INSERT INTO users (id, google_sub, email, name, avatar_url, google_refresh_token, google_access_token, google_token_expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, profile.sub, profile.email, profile.name ?? profile.email, profile.picture ?? null, refresh, encrypt(tokens.access_token), expires, now()],
  );
  return id;
}

/** Local-only fake users for development (DEV_LOGIN=1). */
export async function upsertDevUser(handle) {
  const sub = `dev:${handle}`;
  const existing = await db.get("SELECT id FROM users WHERE google_sub = ?", [sub]);
  if (existing) return existing.id;
  const id = newId();
  const name = handle.replace(/^./, (c) => c.toUpperCase());
  await db.run("INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?)", [
    id, sub, `${handle}@example.test`, name, now(),
  ]);
  return id;
}

export async function disconnectGoogle(userId) {
  await db.batch([
    {
      sql: `UPDATE users SET google_refresh_token = NULL, google_access_token = NULL, google_token_expires_at = NULL,
                   google_list_id = NULL, google_last_pull = NULL, google_sync_error = NULL WHERE id = ?`,
      args: [userId],
    },
    { sql: "DELETE FROM google_links WHERE user_id = ?", args: [userId] },
  ]);
}

import { db } from "../db/client.js";
import { config } from "../config.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { TOKEN_URL } from "../auth/google-oauth.js";

export class NotConnectedError extends Error {}

/** Returns a valid access token for the user, refreshing it with the stored refresh token when needed. */
export async function getAccessToken(userId, { force = false } = {}) {
  const user = await db.get(
    "SELECT google_refresh_token, google_access_token, google_token_expires_at FROM users WHERE id = ?",
    [userId],
  );
  if (!user?.google_refresh_token) throw new NotConnectedError("Google account not connected");
  const fresh = user.google_token_expires_at && user.google_token_expires_at > new Date(Date.now() + 60_000).toISOString();
  if (!force && fresh && user.google_access_token) return decrypt(user.google_access_token);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      refresh_token: decrypt(user.google_refresh_token),
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === "invalid_grant") {
      // Revoked, expired (7-day limit for apps in "Testing"), or password changed: ask the user to reconnect.
      await db.run(
        "UPDATE users SET google_refresh_token = NULL, google_access_token = NULL, google_sync_error = ? WHERE id = ?",
        ["Google access expired or was revoked. Sign in with Google again to resume syncing.", userId],
      );
      throw new NotConnectedError("Google refresh token is no longer valid");
    }
    throw new Error(`Token refresh failed: ${data.error_description ?? data.error ?? res.status}`);
  }
  await db.run("UPDATE users SET google_access_token = ?, google_token_expires_at = ? WHERE id = ?", [
    encrypt(data.access_token),
    new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
    userId,
  ]);
  return data.access_token;
}

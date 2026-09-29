// Google OAuth 2.0 authorization-code flow with PKCE, done with plain fetch.
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { randomToken, sign, unsign } from "../lib/crypto.js";
import { HttpError, setCookie } from "../lib/http.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const TASKS_SCOPE = "https://www.googleapis.com/auth/tasks";
const STATE_COOKIE = "sloth_oauth";

const redirectUri = () => `${config.baseUrl}/auth/google/callback`;

/** Only allow relative, same-site redirect targets. */
export const safeNext = (next) => (typeof next === "string" && /^\/(?![/\\])/.test(next) ? next : "/");

export function beginGoogleLogin(res, next = "/") {
  const state = randomToken(16);
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  setCookie(res, STATE_COOKIE, sign(JSON.stringify({ state, verifier, next: safeNext(next) })), {
    maxAge: 600,
    secure: config.baseUrl.startsWith("https"),
  });
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: `openid email profile ${TASKS_SCOPE}`,
    access_type: "offline",      // we need a refresh token to sync in the background
    prompt: "consent",           // ...and Google only re-issues one when consent is shown
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params}`;
}

/** Exchanges the callback code for tokens and fetches the user's profile. */
export async function completeGoogleLogin(res, cookies, query) {
  setCookie(res, STATE_COOKIE, "", { maxAge: 0 });
  const saved = unsign(cookies[STATE_COOKIE]);
  if (!saved) throw new HttpError(400, "Sign-in expired, please try again");
  const { state, verifier, next } = JSON.parse(saved);
  if (query.get("error")) throw new HttpError(400, `Google sign-in was cancelled (${query.get("error")})`);
  if (!query.get("state") || query.get("state") !== state) throw new HttpError(400, "Sign-in state mismatch, please try again");

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: query.get("code") ?? "",
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) throw new HttpError(400, `Google sign-in failed: ${tokens.error_description ?? tokens.error}`);

  const profileRes = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!profileRes.ok) throw new HttpError(502, "Couldn't read your Google profile");
  const profile = await profileRes.json();
  const grantedTasks = String(tokens.scope ?? "").split(" ").includes(TASKS_SCOPE);
  return { profile, tokens, next, grantedTasks };
}

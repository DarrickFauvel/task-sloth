/** Central place for environment configuration. */
const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3000),
  baseUrl: (env.BASE_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/$/, ""),
  isProduction: env.NODE_ENV === "production",
  sessionSecret: env.SESSION_SECRET ?? "dev-only-insecure-secret-change-me",
  // On by default under `pnpm dev` so local sign-in works without Google; DEV_LOGIN=0 turns it off.
  devLogin: (env.DEV_LOGIN ?? (env.npm_lifecycle_event === "dev" ? "1" : "0")) === "1" && env.NODE_ENV !== "production",
  db: {
    url: env.TURSO_DATABASE_URL ?? "file:data/local.db",
    authToken: env.TURSO_AUTH_TOKEN || undefined,
  },
  google: {
    clientId: env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    syncIntervalMs: Number(env.GOOGLE_SYNC_INTERVAL_SECONDS ?? 120) * 1000,
    listTitle: env.GOOGLE_TASK_LIST_TITLE ?? "Task Sloth",
  },
};

export const googleConfigured = () => Boolean(config.google.clientId && config.google.clientSecret);

if (config.isProduction && config.sessionSecret.startsWith("dev-only")) {
  throw new Error("SESSION_SECRET must be set in production");
}

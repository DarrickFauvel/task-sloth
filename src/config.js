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
  // Task photos: CLOUDINARY_URL is cloudinary://<api key>:<api secret>@<cloud name>, as Cloudinary's dashboard shows it.
  cloudinary: parseCloudinaryUrl(env.CLOUDINARY_URL),
  // Sending email: SMTP_URL is smtp://<user>:<password>@<host>:<port> (smtps:// for implicit TLS on 465);
  // MAIL_FROM is the sender, e.g. "Task Sloth <noreply@example.com>".
  mail: parseSmtpUrl(env.SMTP_URL, env.MAIL_FROM),
};

function parseSmtpUrl(value, from) {
  try {
    const u = new URL(value);
    if (!["smtp:", "smtps:"].includes(u.protocol) || !u.hostname || !from?.trim()) return null;
    const secure = u.protocol === "smtps:";
    return {
      host: u.hostname,
      port: Number(u.port) || (secure ? 465 : 587),
      secure,
      user: decodeURIComponent(u.username),
      pass: decodeURIComponent(u.password),
      from: from.trim(),
    };
  } catch {
    return null;
  }
}

function parseCloudinaryUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== "cloudinary:" || !u.username || !u.password || !u.hostname) return null;
    return { cloudName: u.hostname, apiKey: decodeURIComponent(u.username), apiSecret: decodeURIComponent(u.password) };
  } catch {
    return null;
  }
}

export const googleConfigured = () => Boolean(config.google.clientId && config.google.clientSecret);
export const photosConfigured = () => Boolean(config.cloudinary);
export const mailConfigured = () => Boolean(config.mail);

if (config.isProduction && config.sessionSecret.startsWith("dev-only")) {
  throw new Error("SESSION_SECRET must be set in production");
}

import { ServerSentEventGenerator } from "@starfederation/datastar-sdk";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendHtml(res, html, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

export function redirect(res, location, status = 303) {
  res.writeHead(status, { Location: location });
  res.end();
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((p) => p.trim().split("="))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]),
  );
}

export function setCookie(res, name, value, { maxAge, httpOnly = true, secure = false, path = "/" } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, "SameSite=Lax"];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  const prev = res.getHeader("Set-Cookie") ?? [];
  res.setHeader("Set-Cookie", [...(Array.isArray(prev) ? prev : [prev]), parts.join("; ")]);
}

const MAX_BODY = 256 * 1024;

/** Reads a urlencoded or JSON body (what Datastar sends) into a plain object. */
export async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

/**
 * Runs `fn` with a Datastar SSE stream. Use for every Datastar action response.
 * @param {(sse: ServerSentEventGenerator) => Promise<void> | void} fn
 */
export function sse(req, res, fn, options) {
  return ServerSentEventGenerator.stream(req, res, fn, options);
}

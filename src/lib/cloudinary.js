// Just enough of Cloudinary's API for task photos: a signed upload, a delete, and signed delivery URLs.
// Photos are "authenticated" images: Cloudinary serves them only on a signed URL, and only the server
// signs one (to fetch a photo for someone in its household), so a photo never has a public link.
// Signed requests are sha1 over the sorted params plus the API secret:
// https://cloudinary.com/documentation/authentication_signatures

import { createHash } from "node:crypto";
import { config } from "../config.js";
import { HttpError } from "./http.js";

/** The request signature for `params` (every param except file, api_key and resource_type). */
export function sign(params, apiSecret) {
  const payload = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(payload + apiSecret).digest("hex");
}

async function call(action, params, file) {
  const { cloudName, apiKey, apiSecret } = config.cloudinary ?? {};
  if (!cloudName) throw new HttpError(503, "Photos aren't set up on this server");
  const signed = { ...params, timestamp: Math.floor(Date.now() / 1000) };
  const form = new FormData();
  for (const [k, v] of Object.entries(signed)) form.set(k, String(v));
  form.set("api_key", apiKey);
  form.set("signature", sign(signed, apiSecret));
  if (file) form.set("file", file);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/${action}`, { method: "POST", body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Cloudinary ${action} failed (${res.status}): ${body.error?.message ?? "no details"}`);
  return body;
}

/** Uploads a private image into `folder`; Cloudinary picks a random public_id. */
export async function uploadImage(bytes, type, { folder }) {
  const { public_id, width, height } = await call("upload", { folder, type: "authenticated" }, new Blob([bytes], { type }));
  return { publicId: public_id, width, height };
}

export async function destroyImage(publicId) {
  await call("destroy", { public_id: publicId, type: "authenticated", invalidate: "true" });
}

/**
 * A signed delivery URL for a private image, e.g. signedImageUrl(id, "c_fill,w_300,h_300") for a square
 * thumbnail; format and quality suit the requesting browser. For the server's own use: whoever has it can
 * see the photo. The signature is the first 8 chars of url-safe base64 sha1(<transform>/<public_id> + secret).
 */
export function signedImageUrl(publicId, transform = "c_limit,w_1600,h_1600") {
  const { cloudName, apiSecret } = config.cloudinary;
  const path = `${transform},f_auto,q_auto/${publicId}`;
  const signature = createHash("sha1").update(path + apiSecret).digest("base64url").slice(0, 8);
  return `https://res.cloudinary.com/${cloudName}/image/authenticated/s--${signature}--/${path}`;
}

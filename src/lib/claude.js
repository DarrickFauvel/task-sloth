// Just enough of the Claude API for project plans: one request that answers with JSON matching a schema.
// Claude Opus 5.5 with server-side fallbacks: if it declines a request, the API retries it on a fallback
// model in the same call. Errors become an HttpError(502) with a message the page can show as is.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { HttpError } from "./http.js";

export const MODEL = "claude-opus-5-5";
const UNAVAILABLE = "Claude couldn't answer just now. Try again in a minute.";

/** @type {Anthropic | null} */
let client = null;
let clientKey = null;
function getClient() {
  // Look fetch up on each call, so tests can stub globalThis.fetch as they do for Cloudinary.
  if (!client || clientKey !== config.anthropic.apiKey) {
    clientKey = config.anthropic.apiKey;
    client = new Anthropic({ apiKey: clientKey, fetch: (...args) => globalThis.fetch(...args), maxRetries: 1 });
  }
  return client;
}

/**
 * Asks Claude and returns its answer parsed from JSON.
 * @param {{ system: string, content: Anthropic.Beta.BetaContentBlockParam[], schema: object }} request
 */
export async function askForJson({ system, content, schema }) {
  let response;
  try {
    response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema } },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
    });
  } catch (err) {
    // 400s are ours (a photo link Claude couldn't fetch, say); the rest is Claude being busy or down, or the network.
    console.error("Claude request failed", err instanceof Anthropic.APIError ? err.status : "", err.message);
    throw new HttpError(502, err instanceof Anthropic.BadRequestError ? "Claude couldn't read that. If you added photos, try different ones." : UNAVAILABLE);
  }
  if (response.stop_reason === "refusal") {
    console.error("Claude declined", response.stop_details?.category ?? "");
    throw new HttpError(502, "Claude couldn't help with that one. Try putting it another way.");
  }
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    if (response.stop_reason === "max_tokens") throw new Error("cut off");
    return JSON.parse(text);
  } catch {
    console.error("Claude's answer wasn't usable JSON", response.stop_reason);
    throw new HttpError(502, UNAVAILABLE);
  }
}

// Address search for giving a where/how its place (the Where / how page): OpenStreetMap's Nominatim.
// What someone types is sent there, from the server, with a rough area to look in first: the browser's position
// rounded to about 10 km, or the household's first spot.
// Nominatim's usage policy: an app that identifies itself, at most one request a second, and searches people
// ask for (a Search button), not search-as-you-type. https://operations.osmfoundation.org/policies/nominatim/

import { config } from "../config.js";
import { HttpError } from "../lib/http.js";
import { cleanCoords } from "../../public/js/lib/places.js";

export const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const GAP_MS = 1100;
/** How far around `near` a search looks first, in degrees (about 50 km). */
const NEARBY_DEGREES = 0.5;

let nextSlot = 0;
/** Waits for this server's turn, so searches go out at most once a second whoever makes them. */
async function takeTurn() {
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Math.max(nextSlot, Date.now()) + GAP_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

/** "Target, 1234, Main Street, Springfield, Sangamon County, Illinois, 62704, United States" → the first few parts. */
export const shortAddress = (text) => String(text ?? "").split(", ").slice(0, 4).join(", ");

/**
 * A result as people say it: "Aldi, Worcester, MA" (its name, town, and state, as the US code where there is one),
 * or "500 Lincoln Street, Worcester, MA" for a plain address. `withStreet` adds the street after a name, to tell
 * two branches in one town apart. Without address details it falls back to shortAddress.
 */
export function placeLabel(r, { withStreet = false } = {}) {
  const a = r.address;
  if (!a) return shortAddress(r.display_name);
  const street = [a.house_number, a.road].filter(Boolean).join(" ");
  const town = a.city ?? a.town ?? a.village ?? a.municipality ?? a.hamlet ?? a.suburb ?? a.county;
  const code = a["ISO3166-2-lvl4"]?.match(/^US-([A-Z]{2})$/)?.[1];
  const region = code ?? a.state ?? a.country;
  const name = r.name && r.name !== street ? r.name : "";
  const parts = [name || street, name && withStreet ? street : "", town, region].filter(Boolean);
  return [...new Set(parts)].join(", ") || shortAddress(r.display_name);
}

/**
 * Up to 5 places matching `query`, as { label, lat, lng }. With `near` ({ lat, lng }, optional) it looks within
 * about 50 km of it first, and further only if nothing's there: otherwise "Aldi Shrewsbury" finds Shrewsbury,
 * England before Shrewsbury, MA. Throws a 400 for an empty search and a 502 when Nominatim doesn't answer.
 */
export async function searchPlaces(query, near = null) {
  const q = String(query ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!q) throw new HttpError(400, "Type an address or a place name to search for.");
  const c = near && cleanCoords(near.lat, near.lng);
  if (c) {
    const d = NEARBY_DEGREES;
    const nearby = await ask({ q, viewbox: [c.lng - d, c.lat + d, c.lng + d, c.lat - d].join(","), bounded: "1" });
    if (nearby.length) return nearby;
  }
  return ask({ q });
}

/** One Nominatim search, as labelled places (see searchPlaces). */
async function ask(extra) {
  const params = new URLSearchParams({ format: "jsonv2", limit: "5", addressdetails: "1", ...extra });
  await takeTurn();
  let rows;
  try {
    const res = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { "User-Agent": `TaskSloth/1.0 (${config.baseUrl})`, "Accept-Language": "en" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Nominatim answered ${res.status}`);
    rows = await res.json();
  } catch (err) {
    console.error("address search failed", err);
    throw new HttpError(502, "Address search isn't answering right now. Try again, or use “I'm here now”.");
  }
  const found = (Array.isArray(rows) ? rows : []).filter((r) => cleanCoords(r.lat, r.lon));
  // Short labels, unless two would read the same (two Aldis in one town): those get their street.
  const labels = found.map((r) => placeLabel(r));
  return found
    .map((r, i) => ({ label: labels.indexOf(labels[i]) !== labels.lastIndexOf(labels[i]) ? placeLabel(r, { withStreet: true }) : labels[i], ...cleanCoords(r.lat, r.lon) }))
    .filter((r) => r.label);
}

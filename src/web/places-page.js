/**
 * The Where / how page (views/pages/places.eta): every where/how (`rows`, one add-a-spot sheet each), split into
 * `onMap` (with their spots) and `offMap`.
 * `contexts` come from listContexts and `spots` from listSpots; `search` is an address search's outcome for one
 * where/how ({ contextId, query, results, error }), shown under that row. `timeZone` is the viewer's, for dates.
 */
export function placesPageView(contexts, spots, search = null, timeZone = "UTC") {
  const savedOn = (iso) => (iso ? ` on ${dateFormat(timeZone).format(new Date(iso))}` : "");
  const rows = contexts.map((cx) => {
    const mine = spots.filter((s) => s.context_id === cx.id);
    return {
      id: cx.id,
      name: cx.name,
      openCount: Number(cx.open_count ?? 0),
      isPlace: mine.length > 0,
      spots: mine.map((s) => ({ id: s.id, text: s.label || `Saved where someone stood${savedOn(s.created_at)}`, mapHref: mapHref(s.lat, s.lng) })),
      search: search?.contextId === cx.id ? search : null,
    };
  });
  // The page shows where/hows on the map first, each with its spots, then the rest as chips.
  return { rows, onMap: rows.filter((r) => r.isPlace), offMap: rows.filter((r) => !r.isPlace) };
}

/** "Oct 2": when an "I'm here now" spot was saved, so two of them can be told apart. An unknown zone falls back to UTC. */
function dateFormat(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" });
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  }
}

export const mapHref = (lat, lng) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`;

/**
 * What the home page's "Near you" (public/js/near-you.js) needs about each spot: where it is, its where/how's id
 * and name, how many to-dos are there and a link to them. Places with nothing to do are left out: there's nothing
 * to say.
 */
export const nearYouPlaces = (places) =>
  places
    .filter((p) => p.count > 0)
    .map((p) => ({ id: p.id, contextId: p.context_id, name: p.name, lat: p.lat, lng: p.lng, count: p.count, href: `/?view=all&context=${encodeURIComponent(p.context_id)}` }));

/** Where address searches lean towards when the browser didn't send a position: the household's first spot. */
export const searchNudge = (spots) => (spots.length ? { lat: spots[0].lat, lng: spots[0].lng } : null);

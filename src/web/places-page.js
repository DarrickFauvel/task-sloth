/**
 * The Where / how page (views/pages/places.eta): every where/how, whether it's a place, and the ways to set one.
 * `contexts` come from listContexts; `search` is an address search's outcome for one of them
 * ({ contextId, query, results, error }), shown under that row.
 */
export function placesPageView(contexts, search = null) {
  return {
    rows: contexts.map((cx) => ({
      id: cx.id,
      name: cx.name,
      openCount: Number(cx.open_count ?? 0),
      isPlace: cx.place_lat != null,
      placeText: cx.place_lat == null ? "" : cx.place_label || "Set where someone was standing",
      mapHref: cx.place_lat == null ? "" : mapHref(cx.place_lat, cx.place_lng),
      search: search?.contextId === cx.id ? search : null,
    })),
  };
}

export const mapHref = (lat, lng) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`;

/**
 * What the home page's "Near you" (public/js/near-you.js) needs about each place: where it is, its name, how
 * many to-dos are there and a link to them. Places with nothing to do are left out: there's nothing to say.
 */
export const nearYouPlaces = (places) =>
  places
    .filter((p) => p.count > 0)
    .map((p) => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, count: p.count, href: `/?view=all&context=${encodeURIComponent(p.id)}` }));

/** Where address searches lean towards when the browser didn't send a position: the household's first place. */
export const searchNudge = (contexts) => {
  const p = contexts.find((cx) => cx.place_lat != null);
  return p ? { lat: p.place_lat, lng: p.place_lng } : null;
};

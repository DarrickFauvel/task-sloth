// "Near you": which saved place (a where/how with a spot on the map) the phone is at. Shared by the server
// (checking coordinates people send) and the browser (public/js/near-you.js); pure.
//
// You're near a place within NEAR_METERS of it, and stay near it until you're LEAVE_METERS away, so a
// reading that wobbles at the edge doesn't keep flipping the banner (and the notification) on and off.

export const NEAR_METERS = 200;
export const LEAVE_METERS = 350;
/** Readings vaguer than this (a phone with no GPS fix yet, say) can't tell which shop you're in, so they're skipped. */
export const MAX_ACCURACY_METERS = 500;

/** Latitude and longitude as numbers in range, or null. Accepts strings, as forms send them. */
export function cleanCoords(lat, lng) {
  if (lat === "" || lng === "" || lat == null || lng == null) return null;
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: a, lng: b };
}

/** Meters between two points on the earth (haversine). */
export function distanceMeters(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The place you're at, or null. `places` are { id, lat, lng, … }; `currentId` is the place you were near last
 * time, which you stay near until LEAVE_METERS. Otherwise it's the closest place within NEAR_METERS.
 * `position` is { lat, lng, accuracy }; a vague one (see MAX_ACCURACY_METERS) changes nothing.
 */
export function nearestPlace(position, places, currentId = null) {
  const current = places.find((p) => p.id === currentId) ?? null;
  if (position.accuracy > MAX_ACCURACY_METERS) return current;
  if (current && distanceMeters(position, current) <= LEAVE_METERS) return current;
  let best = null;
  let bestDistance = NEAR_METERS;
  for (const p of places) {
    const d = distanceMeters(position, p);
    if (d <= bestDistance) (best = p), (bestDistance = d);
  }
  return best;
}

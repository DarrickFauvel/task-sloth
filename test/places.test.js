import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createTask, setDone } from "../src/services/tasks.js";
import { addSpot, ensureContext, listPlaces, listSpots, MAX_SPOTS, removeSpot } from "../src/services/contexts.js";
import { NOMINATIM_URL, placeLabel, searchPlaces, shortAddress } from "../src/services/geocode.js";
import { nearYouPlaces, placesPageView, searchNudge } from "../src/web/places-page.js";
import { cleanCoords, distanceMeters, LEAVE_METERS, nearestPlace, NEAR_METERS } from "../public/js/lib/places.js";

const dir = mkdtempSync(join(tmpdir(), "task-sloth-test-"));
const actor = { id: "u1", householdId: "h1" };
const realFetch = globalThis.fetch;

before(async () => {
  initDb({ url: `file:${join(dir, "test.db")}` });
  await migrate({ log: () => {} });
  const ts = new Date().toISOString();
  await db.batch([
    { sql: "INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'a@example.com', 'Alice', ?)", args: [ts] },
    { sql: "INSERT INTO households (id, name, created_at) VALUES ('h1', 'Home', ?), ('h2', 'Other', ?)", args: [ts, ts] },
    { sql: "INSERT INTO memberships (household_id, user_id, joined_at) VALUES ('h1', 'u1', ?)", args: [ts] },
  ]);
});
afterEach(() => (globalThis.fetch = realFetch));
after(() => rmSync(dir, { recursive: true, force: true }));

// A shop, a spot 100 m north of it, and one about 280 m north.
const shop = { id: "shop", lat: 40.0, lng: -75.0 };
const north = (m) => ({ lat: 40.0 + m / 111_195, lng: -75.0, accuracy: 20 });

test("distanceMeters measures along the earth", () => {
  assert.ok(Math.abs(distanceMeters(shop, north(100)) - 100) < 1);
  assert.equal(distanceMeters(shop, shop), 0);
});

test("nearestPlace: near within NEAR_METERS, and stays near until LEAVE_METERS", () => {
  const far = { id: "far", lat: 41, lng: -75 };
  assert.equal(nearestPlace(north(100), [far, shop])?.id, "shop");
  assert.equal(nearestPlace(north(NEAR_METERS + 80), [shop]), null, "not near yet");
  assert.equal(nearestPlace(north(NEAR_METERS + 80), [shop], "shop")?.id, "shop", "already there: still near");
  assert.equal(nearestPlace(north(LEAVE_METERS + 20), [shop], "shop"), null, "left");
  // The closer of two places wins.
  const nextDoor = { id: "next", lat: 40.0 + 150 / 111_195, lng: -75.0 };
  assert.equal(nearestPlace(north(140), [shop, nextDoor])?.id, "next");
});

test("nearestPlace ignores vague readings", () => {
  assert.equal(nearestPlace({ ...north(10), accuracy: 2000 }, [shop]), null);
  assert.equal(nearestPlace({ ...north(5000), accuracy: 2000 }, [shop], "shop")?.id, "shop", "a vague reading doesn't move you");
});

test("cleanCoords takes numbers in range, from strings too", () => {
  assert.deepEqual(cleanCoords("40.5", "-75.25"), { lat: 40.5, lng: -75.25 });
  assert.equal(cleanCoords("", "1"), null);
  assert.equal(cleanCoords(91, 0), null);
  assert.equal(cleanCoords(0, 181), null);
  assert.equal(cleanCoords("abc", 0), null);
});

test("a where/how gets spots, one per branch; a second save at the same spot updates it", async () => {
  const target = await ensureContext("h1", "Target");
  assert.equal(await addSpot("h1", target, { lat: "40.1", lng: "-75.2", label: "  Target,   Main Street " }), "added");
  assert.equal(await addSpot("h1", target, { lat: 40.3, lng: -75.2 }), "added", "another branch");
  assert.deepEqual((await listSpots("h1")).map((sp) => [sp.lat, sp.lng, sp.label]), [[40.1, -75.2, "Target, Main Street"], [40.3, -75.2, null]]);

  // 30 m from the first: the same shop, so it moves there instead of adding a third.
  assert.equal(await addSpot("h1", target, { lat: 40.1 + 30 / 111_195, lng: -75.2 }), "updated");
  const spots = await listSpots("h1");
  assert.equal(spots.length, 2);
  assert.equal(spots[0].label, null, "I'm here now has no address");

  await assert.rejects(addSpot("h1", target, { lat: "x", lng: 1 }), /couldn't be read/);
  await assert.rejects(addSpot("h2", target, { lat: 1, lng: 1 }), /not found/);
  await assert.rejects(removeSpot("h2", spots[0].id), /not found/);
  assert.deepEqual(await listSpots("h2"), []);

  await removeSpot("h1", spots[0].id);
  assert.deepEqual((await listSpots("h1")).map((sp) => sp.id), [spots[1].id]);
  await removeSpot("h1", spots[1].id);
});

test("a where/how has at most MAX_SPOTS spots", async () => {
  const cafe = await ensureContext("h1", "Cafe");
  for (let i = 0; i < MAX_SPOTS; i++) await addSpot("h1", cafe, { lat: 10 + i * 0.01, lng: 10 });
  await assert.rejects(addSpot("h1", cafe, { lat: 20, lng: 20 }), /already has 20 spots/);
  for (const sp of await listSpots("h1")) await removeSpot("h1", sp.id);
});

test("listPlaces lists every spot with its where/how's open to-dos, and Near you skips ones with none", async () => {
  const store = await ensureContext("h1", "Hardware Store");
  const phone = await ensureContext("h1", "Phone");
  await addSpot("h1", store, { lat: 40, lng: -75 });
  await addSpot("h1", store, { lat: 41, lng: -75 });
  const nails = await createTask(actor, { title: "nails", contextId: store, list: "todo" });
  await createTask(actor, { title: "paint", contextId: store, list: "todo" });
  await createTask(actor, { title: "maybe a ladder", contextId: store, list: "someday" });
  await createTask(actor, { title: "glue", contextId: store, list: "todo", waitingTaskId: nails });
  await createTask(actor, { title: "call mum", contextId: phone, list: "todo" });
  let places = await listPlaces("h1");
  assert.deepEqual(places.map((p) => [p.name, p.lat, p.count]), [["Hardware Store", 40, 2], ["Hardware Store", 41, 2]],
    "not a place: not listed; blocked and Maybe later don't count");

  await setDone(actor, nails, true);
  places = await listPlaces("h1");
  assert.equal(places[0].count, 2, "glue isn't blocked any more; nails is done");
  assert.deepEqual(nearYouPlaces(places)[0], { id: places[0].id, contextId: store, name: "Hardware Store", lat: 40, lng: -75, count: 2, href: `/?view=all&context=${store}` });
  assert.deepEqual(nearYouPlaces([{ ...places[0], count: 0 }]), []);
});

test("placesPageView lists each where/how's spots and attaches a search to its row", () => {
  const view = placesPageView([
    { id: "a", name: "Target", open_count: 3 },
    { id: "c", name: "Phone", open_count: 1 },
  ], [
    { id: "s1", context_id: "a", lat: 40, lng: -75, label: "Target, Main Street" },
    { id: "s2", context_id: "a", lat: 41, lng: -74, label: null, created_at: "2026-10-02T15:00:00.000Z" },
  ], { contextId: "c", query: "x", results: [], error: "Nothing found" }, "America/New_York");
  assert.deepEqual(view.rows.map((r) => [r.name, r.isPlace, r.spots.map((sp) => sp.text), r.search?.error ?? null]), [
    ["Target", true, ["Target, Main Street", "Saved where someone stood on Oct 2"], null],
    ["Phone", false, [], "Nothing found"],
  ]);
  assert.match(placesPageView([{ id: "a", name: "T" }], [{ id: "s", context_id: "a", lat: 1, lng: 1, created_at: "2026-10-03T02:00:00.000Z" }], null, "America/New_York").rows[0].spots[0].text,
    /on Oct 2$/, "late evening in New York is still the 2nd");
  assert.match(view.rows[0].spots[0].mapHref, /openstreetmap\.org\/\?mlat=40&mlon=-75/);
  assert.deepEqual(searchNudge([{ lat: 41, lng: -74 }, { lat: 1, lng: 1 }]), { lat: 41, lng: -74 });
  assert.equal(searchNudge([]), null);
});

test("searchPlaces asks Nominatim politely and shortens what it says", async () => {
  let asked;
  globalThis.fetch = async (url, init) => {
    asked = { url: new URL(url), init };
    return Response.json([
      { display_name: "Target, 1234, Main Street, Springfield, Sangamon County, Illinois, 62704, United States", lat: "39.78", lon: "-89.65" },
      { display_name: "Broken", lat: "nope", lon: "0" },
    ]);
  };
  const results = await searchPlaces("  target  springfield ", { lat: 39.8, lng: -89.6 });
  assert.deepEqual(results, [{ label: "Target, 1234, Main Street, Springfield", lat: 39.78, lng: -89.65 }]);
  assert.equal(`${asked.url.origin}${asked.url.pathname}`, NOMINATIM_URL);
  assert.equal(asked.url.searchParams.get("q"), "target springfield");
  assert.equal(asked.url.searchParams.get("bounded"), "1", "nearby first");
  assert.deepEqual(asked.url.searchParams.get("viewbox").split(",").map(Number).map((n) => Math.round(n * 10) / 10), [-90.1, 40.3, -89.1, 39.3]);
  assert.match(asked.init.headers["User-Agent"], /^TaskSloth\//);

  globalThis.fetch = async (url) => ((asked = { url: new URL(url) }), Response.json([]));
  await searchPlaces("target");
  assert.equal(asked.url.searchParams.get("viewbox"), null, "no area: no nudge");
});

test("searchPlaces looks further only when nothing's nearby", async () => {
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    asked.push(u.searchParams.get("bounded"));
    return Response.json(u.searchParams.get("bounded") ? [] : [{ name: "Aldi", display_name: "x", lat: "52.7", lon: "-2.7", address: { city: "Shrewsbury", state: "England" } }]);
  };
  assert.deepEqual((await searchPlaces("aldi shrewsbury", { lat: 42.3, lng: -71.7 })).map((r) => r.label), ["Aldi, Shrewsbury, England"]);
  assert.deepEqual(asked, ["1", null]);
});

test("searchPlaces: an empty search is a 400, a failing service a 502", async () => {
  await assert.rejects(searchPlaces("   "), (err) => err.status === 400);
  const quiet = console.error;
  console.error = () => {};
  try {
    globalThis.fetch = async () => new Response("slow down", { status: 429 });
    await assert.rejects(searchPlaces("target"), (err) => err.status === 502 && /I'm here now/.test(err.message));
    globalThis.fetch = async () => Promise.reject(new TypeError("fetch failed"));
    await assert.rejects(searchPlaces("target"), (err) => err.status === 502);
  } finally {
    console.error = quiet;
  }
});

test("shortAddress keeps the first few parts", () => {
  assert.equal(shortAddress("A, B, C, D, E"), "A, B, C, D");
  assert.equal(shortAddress(undefined), "");
});

test("placeLabel says a result the short way, adding the street only to tell two apart", () => {
  const aldi = (street, town) => ({
    name: "Aldi", display_name: "long",
    address: { shop: "Aldi", house_number: street[0], road: street[1], hamlet: "Beverly Road", city: town, county: "Worcester County", state: "Massachusetts", "ISO3166-2-lvl4": "US-MA", country: "United States" },
  });
  assert.equal(placeLabel(aldi(["500", "Lincoln Street"], "Worcester")), "Aldi, Worcester, MA");
  assert.equal(placeLabel(aldi(["500", "Lincoln Street"], "Worcester"), { withStreet: true }), "Aldi, 500 Lincoln Street, Worcester, MA");
  assert.equal(placeLabel({ name: "", display_name: "x", address: { house_number: "12", road: "Elm St", town: "Milford", state: "Massachusetts", "ISO3166-2-lvl4": "US-MA" } }),
    "12 Elm St, Milford, MA", "a plain address leads with the street");
  assert.equal(placeLabel({ name: "Tesco", display_name: "x", address: { city: "Leeds", state: "England", "ISO3166-2-lvl4": "GB-ENG" } }), "Tesco, Leeds, England", "outside the US: the state's name");
  assert.equal(placeLabel({ display_name: "A, B, C, D, E" }), "A, B, C, D", "no details: the first parts");
});

test("searchPlaces gives same-town branches their street", async () => {
  const branch = (n, road) => ({ name: "Aldi", display_name: "x", lat: "42.2", lon: `-71.${n}`, address: { house_number: n, road, city: "Worcester", "ISO3166-2-lvl4": "US-MA" } });
  globalThis.fetch = async () => Response.json([branch("500", "Lincoln Street"), branch("30", "Mill Street"),
    { name: "Aldi", display_name: "x", lat: "42.1", lon: "-71.5", address: { town: "Milford", "ISO3166-2-lvl4": "US-MA" } }]);
  assert.deepEqual((await searchPlaces("aldi")).map((r) => r.label), ["Aldi, 500 Lincoln Street, Worcester, MA", "Aldi, 30 Mill Street, Worcester, MA", "Aldi, Milford, MA"]);
});

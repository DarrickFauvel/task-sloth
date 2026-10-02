import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createTask, setDone } from "../src/services/tasks.js";
import { clearPlace, ensureContext, listContexts, listPlaces, setPlace } from "../src/services/contexts.js";
import { NOMINATIM_URL, searchPlaces, shortAddress } from "../src/services/geocode.js";
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

test("a where/how gets a place and loses it, within its household only", async () => {
  const target = await ensureContext("h1", "Target");
  await setPlace("h1", target, { lat: "40.1", lng: "-75.2", label: "  Target,   Main Street " });
  let cx = (await listContexts("h1")).find((c) => c.id === target);
  assert.deepEqual([cx.place_lat, cx.place_lng, cx.place_label], [40.1, -75.2, "Target, Main Street"]);

  await setPlace("h1", target, { lat: 40.2, lng: -75.3 });
  cx = (await listContexts("h1")).find((c) => c.id === target);
  assert.equal(cx.place_label, null, "I'm here now has no address");

  await assert.rejects(setPlace("h1", target, { lat: "x", lng: 1 }), /couldn't be read/);
  await assert.rejects(setPlace("h2", target, { lat: 1, lng: 1 }), /not found/);
  await assert.rejects(clearPlace("h2", target), /not found/);

  await clearPlace("h1", target);
  cx = (await listContexts("h1")).find((c) => c.id === target);
  assert.equal(cx.place_lat, null);
});

test("listPlaces counts the open to-dos at each place, and Near you skips places with none", async () => {
  const store = await ensureContext("h1", "Hardware Store");
  const phone = await ensureContext("h1", "Phone");
  await setPlace("h1", store, { lat: 40, lng: -75 });
  const nails = await createTask(actor, { title: "nails", contextId: store, list: "todo" });
  await createTask(actor, { title: "paint", contextId: store, list: "todo" });
  await createTask(actor, { title: "maybe a ladder", contextId: store, list: "someday" });
  await createTask(actor, { title: "glue", contextId: store, list: "todo", waitingTaskId: nails });
  await createTask(actor, { title: "call mum", contextId: phone, list: "todo" });
  let places = await listPlaces("h1");
  assert.deepEqual(places.map((p) => [p.name, p.count]), [["Hardware Store", 2]], "not a place: not listed; blocked and Maybe later don't count");

  await setDone(actor, nails, true);
  places = await listPlaces("h1");
  assert.equal(places[0].count, 2, "glue isn't blocked any more; nails is done");
  assert.deepEqual(nearYouPlaces(places), [{ id: store, name: "Hardware Store", lat: 40, lng: -75, count: 2, href: `/?view=all&context=${store}` }]);
  assert.deepEqual(nearYouPlaces([{ ...places[0], count: 0 }]), []);
});

test("placesPageView describes each where/how and attaches a search to its row", () => {
  const view = placesPageView([
    { id: "a", name: "Target", open_count: 3, place_lat: 40, place_lng: -75, place_label: "Target, Main Street" },
    { id: "b", name: "Mall", open_count: 0, place_lat: 41, place_lng: -74, place_label: null },
    { id: "c", name: "Phone", open_count: 1, place_lat: null, place_lng: null, place_label: null },
  ], { contextId: "c", query: "x", results: [], error: "Nothing found" });
  assert.deepEqual(view.rows.map((r) => [r.name, r.isPlace, r.placeText, r.search?.error ?? null]), [
    ["Target", true, "Target, Main Street", null],
    ["Mall", true, "Set where someone was standing", null],
    ["Phone", false, "", "Nothing found"],
  ]);
  assert.match(view.rows[0].mapHref, /openstreetmap\.org\/\?mlat=40&mlon=-75/);
  assert.deepEqual(searchNudge([{ place_lat: null }, { place_lat: 41, place_lng: -74 }]), { lat: 41, lng: -74 });
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
  assert.equal(asked.url.searchParams.get("bounded"), "0");
  assert.deepEqual(asked.url.searchParams.get("viewbox").split(",").map(Number).map((n) => Math.round(n * 10) / 10), [-89.9, 40.1, -89.3, 39.5]);
  assert.match(asked.init.headers["User-Agent"], /^TaskSloth\//);

  globalThis.fetch = async (url) => ((asked = { url: new URL(url) }), Response.json([]));
  await searchPlaces("target");
  assert.equal(asked.url.searchParams.get("viewbox"), null, "no area: no nudge");
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

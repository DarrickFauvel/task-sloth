// The service worker that makes Task Sloth an installable app (registered in views/layout.eta).
// Pages always come from the server, never from a cache: they hold the household's tasks, and they must be
// current. With no connection, a page load shows /offline.html instead of the browser's error.
// Styles, scripts and images are served from the cache and refreshed in the background (stale-while-
// revalidate), so pages start faster. Registered with ?dev=1 outside production, where they come from the
// network first (an edited stylesheet shows on the next load, not the one after) and the cache only offline.
// Live streams (/events), form posts, photos and avatars aren't touched.

const CACHE = "task-sloth-v1";
const OFFLINE = "/offline.html";
const PRECACHE = [OFFLINE, "/css/app.css", "/img/logo.png", "/favicon.png"];
const DATASTAR = "https://cdn.jsdelivr.net/gh/starfederation/datastar@";
const dev = new URL(self.location.href).searchParams.has("dev");

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

// Drop caches from older versions, and take over open pages straight away.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isAsset = (url) =>
  url.origin === self.location.origin
    ? /^\/(css|js|img)\//.test(url.pathname) || url.pathname === "/favicon.png"
    : url.href.startsWith(DATASTAR);

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
    return;
  }
  const url = new URL(request.url);
  if (!isAsset(url)) return;
  if (dev) {
    event.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const fresh = fetch(request).then((res) => {
        if (res.ok) cache.put(request, res.clone());
        return res;
      });
      if (cached) {
        event.waitUntil(fresh.catch(() => {}));
        return cached;
      }
      return fresh;
    }),
  );
});

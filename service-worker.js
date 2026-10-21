const CACHE = "habit-dashboard-v6-1-3-cache-refresh";
const CORE = [
  "./",
  "./index.html",
  "./styles.css?v=6.1",
  "./app.js?v=6.1.3",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Never intercept Google OAuth/API traffic or the auth Worker.
  if (
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("accounts.google.com") ||
    url.hostname.includes("gstatic.com") ||
    url.hostname === "auth.1ntellabs.bar"
  ) return;

  const sameOrigin = url.origin === self.location.origin;
  const isFreshnessSensitive =
    event.request.mode === "navigate" ||
    event.request.destination === "script" ||
    event.request.destination === "style";

  if (sameOrigin && isFreshnessSensitive) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then(cached => cached || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.ok && sameOrigin) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});

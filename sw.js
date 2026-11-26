// Minimal service worker — exists so Android Chrome treats the site as an
// installable app ("Install app", not just a plain shortcut). It deliberately
// caches NOTHING: every request goes straight to the network exactly as it
// would without it, so there is no way for it to serve stale code or prices.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  // A real fetch handler (browsers ignore an empty one), network-only.
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request));
});

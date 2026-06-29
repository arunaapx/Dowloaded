// Velox PWA service worker.
// Cache-first for the app shell; never cache the /api/* endpoints or file downloads.

const CACHE = 'velox-shell-v1';
const SHELL = [
  '.',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Always go to network for the API (jobs, SSE, file downloads).
  if (url.pathname.includes('/api/')) return;
  if (req.method !== 'GET') return;

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      // Cache same-origin shell responses opportunistically.
      if (res.ok && url.origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match('index.html')))
  );
});

/**
 * CFB Pickems — Service Worker v16
 * Caches core app shell for offline / fast load.
 *
 * v10 strategy: NETWORK-FIRST for app shell.
 *   - Old cache-first behaviour caused stale JS/CSS to be served after updates,
 *     forcing two reloads to pick up changes. Network-first guarantees fresh
 *     content when online, with cache fallback when offline.
 *   - Guard against caching chrome-extension://, moz-extension://, devtools://
 *     and other unsupported schemes (silences the "Request scheme … unsupported"
 *     console error from extension-injected fetches).
 *   - Bumped CACHE_NAME → cfb-pickems-v15-3 to invalidate any v9 cached files.
 */

const CACHE_NAME = 'cfb-pickems-v17-3';

const STATIC_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/data-model.js',
  './js/storage.js',
  './js/data-provider.js',
  './js/scoring.js',
  './js/notifications.js',
  './js/backend.js',
  './js/chat.js',
  './js/chatTransport.js',
  './js/history-2025.js',
  './js/chat-ui.js',
  './js/scribeLines.js',
  './js/extra-point.js',
  './js/recap.js',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap',
];

// ── INSTALL ──────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────────────────────────────────
// Delete ALL old caches (any cache name not matching CACHE_NAME), then claim
// every open client so the new SW takes over immediately on the current tab.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── MESSAGE: allow page to trigger immediate SW takeover ─────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ── FETCH ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-http(s) schemes entirely — cannot put these in Cache Storage.
  // This silences chrome-extension://, moz-extension://, devtools://, etc.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Skip non-GET — Cache Storage rejects POST/PUT/etc.
  if (event.request.method !== 'GET') return;

  // ESPN API and CORS proxies: always go to network; fall back to cache if offline.
  if (url.hostname.includes('espn') || url.hostname.includes('corsproxy') || url.hostname.includes('allorigins') || url.hostname.includes('codetabs')) {
    event.respondWith(networkFirst(event.request, false));
    return;
  }

  // App shell + everything else: network-first with cache fallback.
  // This guarantees code updates (new app.js, data-model.js, etc.) are picked
  // up on the next page load instead of requiring a second hard refresh.
  event.respondWith(networkFirst(event.request, true));
});

async function networkFirst(request, cacheOnSuccess) {
  try {
    const response = await fetch(request);
    if (cacheOnSuccess && response && response.ok && response.type === 'basic') {
      // Only cache same-origin successful responses; never cache opaque
      // (cross-origin no-cors) or error responses.
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      } catch (_) { /* swallow — scheme/quota/etc. */ }
    }
    return response;
  } catch (_) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('Offline — content not cached.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

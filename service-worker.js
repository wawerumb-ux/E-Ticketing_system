/**
 * ==============================================================================
 * E-TICKETING SYSTEM — ENTERPRISE OFFLINE SERVICE WORKER
 * File: service-worker.js
 * Scope: '/' (Origin-wide offline engine for User and Admin portals)
 * Features:
 *   - Cache-First for static immutable assets (self-hosted fonts, vendor bundles)
 *   - Network-First with Cache Fallback for dynamic app shells and stylesheets
 *   - Per-user Authorization-hash cache keys to prevent cross-account cache leaks
 *   - Zero caching of non-GET requests (mutations queue into page-side IndexedDB)
 * ==============================================================================
 */
'use strict';

const CACHE_VERSION = 'v8';
const SHELL_CACHE = `e-ticketing-shell-${CACHE_VERSION}`;
const IMMUTABLE_CACHE = `e-ticketing-immutable-${CACHE_VERSION}`;
const DATA_CACHE = `e-ticketing-data-${CACHE_VERSION}`;

// 1. Critical App Shell Static Assets
const SHELL_ASSETS = [
  '/',
  '/user/index.html',
  '/admin/index.html',
  '/shared/css/style.css',
  '/vars.css',
  '/shared/js/api.js',
  '/shared/js/events.js',
  '/shared/js/icons.js',
  '/shared/js/offline-db.js',
  '/shared/js/password-field.js',
  '/shared/js/notification-prefs.js',
  '/shared/js/auth.js',
  '/user/js/app.js',
  '/admin/js/app.js'
];

// 2. Static Immutable Assets (Fonts, Vendored libraries)
const IMMUTABLE_ASSETS = [
  '/shared/fonts/fraunces-latin.woff2',
  '/vendor/qrcode.min.js',
  '/vendor/chart.umd.min.js'
];

// 3. Curated Non-Sensitive GET Data Endpoints
function isCacheableApiPath(pathname) {
  return (
    /^\/api\/tickets(\/\d+(?:\/comments)?)?$/.test(pathname) ||
    /^\/api\/kb\/articles(\/\d+)?$/.test(pathname) ||
    /^\/api\/(categories|departments|notifications|roles|dashboard\/stats|users\/me)$/.test(pathname)
  );
}

// 4. Per-User Isolated Cache Key Generator
function generateUserCacheKey(request) {
  const url = new URL(request.url);
  const authHeader = request.headers.get('Authorization') || '';
  let hash = 5381;
  for (let i = 0; i < authHeader.length; i++) {
    hash = ((hash << 5) + hash + authHeader.charCodeAt(i)) >>> 0;
  }
  return `${url.pathname}?__user_scope=${hash.toString(36)}`;
}

// 5. Lifecycle: Install
self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)),
      caches.open(IMMUTABLE_CACHE).then((cache) => cache.addAll(IMMUTABLE_ASSETS))
    ]).then(() => self.skipWaiting())
  );
});

// 6. Lifecycle: Activate (Evict legacy caches)
self.addEventListener('activate', (event) => {
  const expectedCaches = [SHELL_CACHE, IMMUTABLE_CACHE, DATA_CACHE];
  event.waitUntil(
    caches.keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => !expectedCaches.includes(name))
            .map((staleName) => caches.delete(staleName))
        )
      )
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'SW_READY', version: CACHE_VERSION }));
      })
  );
});

// 7. Lifecycle: Fetch Handling
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Never intercept non-GET requests (mutations bypass SW and persist to IndexedDB)
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin fetches are untouched
  if (url.origin !== self.location.origin) return;

  const pathname = url.pathname;

  // A. Static Immutable Assets -> Cache-First
  if (IMMUTABLE_ASSETS.includes(pathname)) {
    event.respondWith(
      caches.open(IMMUTABLE_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request).then((networkRes) => {
            if (networkRes.ok) cache.put(request, networkRes.clone());
            return networkRes;
          });
        })
      )
    );
    return;
  }

  // B. Curated Data Endpoints -> Network-First with User-Keyed Cache Fallback
  if (isCacheableApiPath(pathname)) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cacheKey = generateUserCacheKey(request);
        try {
          const networkRes = await fetch(request);
          if (networkRes.ok) {
            cache.put(cacheKey, networkRes.clone());
          }
          return networkRes;
        } catch (networkErr) {
          const cached = await cache.match(cacheKey);
          if (cached) {
            const headers = new Headers(cached.headers);
            headers.set('X-ICT-Offline-Source', 'Cache');
            return new Response(cached.body, {
              status: cached.status,
              statusText: cached.statusText,
              headers
            });
          }
          throw networkErr;
        }
      })
    );
    return;
  }

  // C. HTML Navigation Request -> Fresh when online, Fallback to Portal Shell
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((networkRes) => {
          const shellPath = pathname.startsWith('/admin') ? '/admin/index.html' : '/user/index.html';
          const clone = networkRes.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(shellPath, clone));
          return networkRes;
        })
        .catch(() => {
          const shellPath = pathname.startsWith('/admin') ? '/admin/index.html' : '/user/index.html';
          return caches.match(shellPath);
        })
    );
    return;
  }

  // D. App Shell Static Assets -> Network-First with Cached Shell Fallback
  if (SHELL_ASSETS.includes(pathname)) {
    event.respondWith(
      caches.open(SHELL_CACHE).then((cache) =>
        fetch(request)
          .then((networkRes) => {
            if (networkRes.ok) cache.put(request, networkRes.clone());
            return networkRes;
          })
          .catch(() => cache.match(request))
      )
    );
  }
});

// 8. Inter-Process Messaging
self.addEventListener('message', (event) => {
  const data = event.data || {};

  // Evict cached ticket lists after an offline mutation replay
  if (data.type === 'REFRESH_DATA_CACHE') {
    event.waitUntil(
      caches.delete(DATA_CACHE).then(() => {
        if (event.source && typeof event.source.postMessage === 'function') {
          event.source.postMessage({ type: 'DATA_CACHE_CLEARED' });
        }
      })
    );
  }
});

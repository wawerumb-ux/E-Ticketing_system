/*
 * User Portal service worker — offline-capable ticket submission.
 *
 * Caches the app shell on install, serves ticket lists network-first with
 * cache fallback, and NEVER caches POST responses. The offline queue lives in
 * IndexedDB (page-side); the SW only stores GET responses, never auth tokens.
 *
 * Scope: '/' (widened via the Service-Worker-Allowed header Flask sends for
 * this file) so the portal page at '/user' is controlled. All user-specific
 * behavior below is gated on URL paths; other pages are untouched.
 */
'use strict';

const CACHE_NAME = 'user-portal-v5';

const SHELL_URLS = [
    '/user/index.html',
    '/shared/css/style.css',
    '/shared/js/api.js',
    '/shared/js/events.js',
    '/shared/js/icons.js',
    '/shared/js/notification-prefs.js',
    '/user/js/app.js',
    '/vendor/qrcode.min.js'
];

// GET /api/tickets and GET /api/tickets/<id> are the only data URLs we cache.
function isTicketApiPath(pathname) {
    return /^\/api\/tickets(\/\d+)?$/.test(pathname);
}

// Only the user portal navigations get an offline shell. Admin/login paths are
// never cached here, so an offline /admin navigation just fails a fresh fetch
// the way it would without this worker.
function isUserPortalPath(pathname) {
    return pathname.startsWith('/user');
}

// Ticket lists are server-scoped per user (created_by), so a plain URL cache
// key would serve one user's cached list to the next user on a shared origin.
// Key by URL + a hash of the Authorization header: same URL, isolated per user.
function requestCacheKey(request) {
    const url = new URL(request.url);
    const auth = request.headers.get('Authorization') || '';
    let hash = 5381;
    for (let i = 0; i < auth.length; i++) {
        hash = ((hash << 5) + hash + auth.charCodeAt(i)) >>> 0;
    }
    return `${url.pathname}?__cache=${hash.toString(36)}`;
}

// Annotate a cache hit so the page can tell real data from stale data and keep
// its "last synced" line honest (no implied freshness on cached responses).
function markFromCache(response) {
    const headers = new Headers(response.headers);
    if (!headers.has('X-ICT-Cache')) headers.set('X-ICT-Cache', 'hit');
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

async function networkFirst(request, cacheKey) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const response = await fetch(request);
        if (response && response.ok) {
            cache.put(cacheKey, response.clone());
        }
        return response;
    } catch (networkError) {
        const cached = await cache.match(cacheKey);
        if (cached) return markFromCache(cached);
        throw networkError;
    }
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL_URLS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
            ))
            .then(() => self.clients.claim())
            .then(() => self.clients.matchAll({ type: 'window' }))
            .then((clients) => {
                // Tell open pages the SW is live so they (re)run the pending-queue sync.
                clients.forEach((client) => client.postMessage({ type: 'SW_READY' }));
            })
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;

    // POST (and every other non-GET) is passed through untouched — we never
    // cache request bodies or their responses.
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    // All app assets are same-origin (Chart.js/qrcodejs were vendored, TASK 5).
    // Anything cross-origin is left to the network untouched — a worker cannot
    // fully control third-party fetches anyway, and none are required anymore.
    if (url.origin !== self.location.origin) return;

    const pathname = url.pathname;

    // Ticket data: network-first, cached response only as an offline fallback.
    // Cache key is per-user so shared-login machines never cross-leak lists.
    if (isTicketApiPath(pathname)) {
        event.respondWith(networkFirst(request, requestCacheKey(request)));
        return;
    }

    // Page navigation: fresh when online, cached user shell when offline.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (isUserPortalPath(pathname)) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put('/user/index.html', copy));
                    }
                    return response;
                })
                .catch(() => isUserPortalPath(pathname)
                    ? caches.match('/user/index.html')
                    : Promise.reject(new Error('offline: outside user portal scope')))
        );
        return;
    }

    // Shell static assets: network-first with cached fallback. A stale shell
    // never mixes with a fresh index.html (that crash pattern broke the whole
    // login gate on this portal), so the shell is re-validated on every load
    // while staying fully available offline from the last-good cache.
    if (SHELL_URLS.includes(pathname)) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response && response.ok) {
                        caches.open(CACHE_NAME).then((cache) => cache.put(pathname, response.clone()));
                    }
                    return response;
                })
                .catch(() => caches.match(pathname))
        );
    }
});

self.addEventListener('message', (event) => {
    const data = event.data || {};

    // After the page flushes its pending queue, it asks us to evict the cached
    // ticket lists so the next page-fetch re-caches fresh data instead of
    // silently serving a stale cached copy. We never refetch ourselves — the
    // page holds the JWT, the worker must not.
    if (data.type === 'REFRESH_TICKETS_CACHE') {
        event.waitUntil(
            caches.open(CACHE_NAME).then(async (cache) => {
                const keys = await cache.keys();
                await Promise.all(
                    keys
                        .filter((req) => isTicketApiPath(new URL(req.url).pathname))
                        .map((req) => cache.delete(req))
                );
                return null;
            }).then(() => {
                if (event.source && typeof event.source.postMessage === 'function') {
                    event.source.postMessage({ type: 'CACHE_REFRESHED' });
                }
                return null;
            })
        );
    }
});
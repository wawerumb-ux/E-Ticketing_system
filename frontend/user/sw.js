/*
 * Origin-wide service worker — offline engine for BOTH portals.
 *
 * Serves the User portal (/user) and the Admin portal (/admin) app shells,
 * caches a curated set of non-sensitive GET /api endpoints network-first with
 * cache fallback, and NEVER caches POST bodies or their responses. The offline
 * mutation queue lives in IndexedDB (page-side, frontend/shared/js/offline-db.js);
 * the SW only stores GET responses, never auth tokens.
 *
 * Scope: '/' (widened via the Service-Worker-Allowed header Flask sends for
 * this file). The User portal registers it; the Admin portal registers the
 * same URL, so only ONE worker ever controls the origin.
 *
 * Per-user cache keys: ticket lists (and anything else server-scoped) would
 * leak one user's cached data to the next user on a shared origin, so keys are
 * a URL hash of the Authorization header — same URL, isolated per user.
 *
 * Cacheable data endpoints are deliberately limited to non-sensitive reads
 * (tickets, comments, KB, categories, departments, notifications, dashboard
 * stats, own profile, roles). User lists, tokens, webhooks, audit logs,
 * settings and reports are NOT cached — big or credential-adjacent lists stay
 * connection-required and never persist to Cache Storage.
 */
'use strict';

const CACHE_NAME = 'e-ticketing-shell-v18';

const SHELL_URLS = [
    '/user/index.html',
    '/admin/index.html',
    '/shared/css/style.css',
    '/shared/css/vars.css',
    '/shared/js/api.js',
    '/shared/js/events.js',
    '/shared/js/icons.js',
    '/shared/js/offline-db.js',
    '/shared/js/sidebar.js',
    '/shared/js/session-dialog.js',
    '/shared/js/password-field.js',
    '/shared/js/notification-prefs.js',
    '/shared/js/auth.js',
    '/shared/js/tubes-bg.js',
    '/shared/js/sketchbook-doc.js',
    '/user/js/app.js',
    '/admin/js/app.js',
    '/vendor/qrcode.min.js',
    '/vendor/chart.umd.min.js',
    '/vendor/tubes1.min.js',
    // Offline landing — login.html is the front door at /login.
    '/login.html',
    // ICT Support Portal landing page (public front door at /).
    '/landing.html',
    // Laptop spreads — composite pairs used as sketchbook pages 10–12.
    '/shared/assets/laptop/spread-1.jpg',
    '/shared/assets/laptop/spread-2.jpg',
    '/shared/assets/laptop/spread-3.jpg',
    // Sketchbook assets — used by the interactive iframe in landing.html.
    '/shared/assets/sketchbook/bg-wash.jpg',
    '/shared/assets/sketchbook/bloom.png',
    '/shared/assets/sketchbook/botanic-gardens.png',
    '/shared/assets/sketchbook/botany-left.png',
    '/shared/assets/sketchbook/botany-right.png',
    '/shared/assets/sketchbook/buddha-tooth.png',
    '/shared/assets/sketchbook/divider.png',
    '/shared/assets/sketchbook/gardens-by-the-bay.png',
    '/shared/assets/sketchbook/instrument-serif-italic.woff2',
    '/shared/assets/sketchbook/instrument-serif.woff2',
    '/shared/assets/sketchbook/joo-chiat.png',
    '/shared/assets/sketchbook/lau-pa-sat.png',
    '/shared/assets/sketchbook/marina-bay-sands.png',
    '/shared/assets/sketchbook/marina-bay-skyline.png',
    '/shared/assets/sketchbook/merlion.png',
    '/shared/assets/sketchbook/newsreader.woff2',
    '/shared/assets/sketchbook/singapore-river.png',
    // Sidebar brand logo (both portals use the same shared asset).
    '/shared/assets/logo/nakuru%20county%20logo.png',
    // Favicon (dark logo variant).
    '/shared/assets/logo/county%20logo%20dark.jpg',
    '/shared/fonts/fraunces-latin.woff2'
];

// The only GET data endpoints we cache (non-sensitive reads). Everything else
// (POST/PUT/DELETE, and GETs with tokens/users/audit/settings/reports) is left
// to the network untouched.
function isCacheableApiPath(pathname) {
    return (
        /^\/api\/tickets(\/\d+(?:\/comments)?)?$/.test(pathname) ||
        /^\/api\/kb\/articles(\/\d+)?$/.test(pathname) ||
        /^\/api\/(categories|departments|notifications|roles|dashboard\/stats|users\/me)$/.test(pathname)
    );
}

function isUserPortalPath(pathname) {
    return pathname.startsWith('/user');
}

function isAdminPortalPath(pathname) {
    return pathname.startsWith('/admin');
}

function isLandingPath(pathname) {
    return pathname === '/' || pathname === '/login' || pathname === '/login.html';
}

function isPortalNavigation(pathname) {
    return isUserPortalPath(pathname) || isAdminPortalPath(pathname);
}

// Part of the offline application shell that navigation hands back offline.
function portalShellPath(pathname) {
    return isAdminPortalPath(pathname) ? '/admin/index.html' : '/user/index.html';
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
    // All app assets are same-origin (Chart.js/qrcodejs were vendored).
    // Anything cross-origin is left to the network untouched — a worker cannot
    // fully control third-party fetches anyway, and none are required anymore.
    if (url.origin !== self.location.origin) return;

    const pathname = url.pathname;

    // Curated data GETs: network-first, cached response only as an offline
    // fallback. Cache key is per-user so shared-login machines never cross-leak.
    if (isCacheableApiPath(pathname)) {
        event.respondWith(networkFirst(request, requestCacheKey(request)));
        return;
    }

    // Page navigation: fresh when online, cached portal/landing shell when offline.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (isPortalNavigation(pathname) || isLandingPath(pathname)) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(pathname, copy));
                    }
                    return response;
                })
                .catch(() => isPortalNavigation(pathname)
                    ? caches.match(portalShellPath(pathname))
                    : isLandingPath(pathname)
                        ? caches.match('/login.html')
                        : Promise.reject(new Error('offline: outside portal scope')))
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
    // data lists so the next page-fetch re-caches fresh data instead of
    // silently serving a stale cached copy. We never refetch ourselves — the
    // page holds the JWT, the worker must not.
    if (data.type === 'REFRESH_TICKETS_CACHE') {
        event.waitUntil(
            caches.open(CACHE_NAME).then(async (cache) => {
                const keys = await cache.keys();
                await Promise.all(
                    keys
                        .filter((req) => isCacheableApiPath(new URL(req.url).pathname))
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
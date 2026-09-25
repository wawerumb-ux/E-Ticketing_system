// Per-category notification preferences (Settings surface, both portals).
//
// Offline-first: the server is the source of truth for the toggles; a
// localStorage cache keeps the last-known state so Settings renders honestly
// while offline. Writes are always server-bound; offline/uncached toggles are
// disabled with the reason shown (OFF3/OFF4/OFF7).
//
// Depends on: TicketAPI (api.js) and Icons (icons.js). Load order in the
// portals: icons.js -> api.js -> notification-prefs.js -> app.js
//
// Usage:
//   NotificationPrefs.render(document.getElementById('notification-prefs'))
//   NotificationPrefs.save('ticket_updates', false)  // used by toggle handlers
(function () {
    'use strict';

    var CACHE_KEY = 'ntf_prefs_cache';
    var CACHE_TS_KEY = 'ntf_prefs_cache_at';

    function readCache() {
        try {
            var raw = localStorage.getItem(CACHE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function writeCache(data) {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(data));
            localStorage.setItem(CACHE_TS_KEY, new Date().toISOString());
        } catch (e) { /* storage full / disabled — cache is best-effort */ }
    }

    function esc(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getLastSynced() {
        try {
            return localStorage.getItem(CACHE_TS_KEY) || null;
        } catch (e) {
            return null;
        }
    }

    function formatSynced(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        });
    }

    // Loads prefs. Online: server-first with cache fallback. Offline entirely
    // (navigator offline): cache only. Throws when nothing usable exists.
    async function load() {
        if (navigator.onLine === false) {
            var cachedOffline = readCache();
            if (cachedOffline && cachedOffline.categories && cachedOffline.registry) {
                return { data: cachedOffline, source: 'cache' };
            }
            throw new Error('offline-without-cache');
        }
        try {
            var data = await TicketAPI.getNotificationCategoryPreferences();
            if (data && data.categories && data.registry) {
                writeCache(data);
                return { data: data, source: 'server' };
            }
            throw new Error('empty prefs payload');
        } catch (err) {
            var cached = readCache();
            if (cached && cached.categories && cached.registry) {
                return { data: cached, source: 'cache' };
            }
            throw err;
        }
    }

    function rowHtml(cid, meta, enabled) {
        var icon = meta && typeof meta.icon === 'string' && meta.icon ? meta.icon : 'bell';
        var active = !meta || meta.active !== false;
        var checked = enabled ? ' checked' : '';
        var badge = active ? '' : '<span class="pref-badge">Coming soon</span>';
        return '<div class="setting-row pref-row' + (active ? '' : ' is-inert') + '">' +
            '<div class="pref-icon" aria-hidden="true">' + Icons.render(icon) + '</div>' +
            '<div class="setting-label">' +
            '<strong>' + esc(meta.label) + badge + '</strong>' +
            '<p>' + esc(meta.description) + '</p>' +
            '</div>' +
            '<div class="setting-control">' +
            '<label class="toggle-switch">' +
            '<input type="checkbox" role="switch" data-category="' + esc(cid) + '"' +
            ' aria-label="Enable ' + esc(meta.label) + ' notifications"' + checked + '>' +
            '<span class="slider"></span>' +
            '</label>' +
            '</div>' +
            '</div>';
    }

    function offlinePanel() {
        return '<div class="pref-offline">' +
            '<strong>Requires connection</strong>' +
            '<p>Notification preferences could not be loaded because you are offline and no saved copy exists. Reconnect, then open Settings again.</p>' +
            '</div>';
    }

    function notePanel(source) {
        if (source !== 'cache') return '';
        var when = formatSynced(getLastSynced());
        return '<p class="pref-note">' +
            (when ? 'Last synced ' + esc(when) + '. ' : '') +
            'Showing saved preferences. Connect to change them.</p>';
    }

    // Renders the category list (active rows first, then inert "coming soon").
    function render(container, opts) {
        opts = opts || {};
        if (!container) return Promise.resolve();

        return load()
            .then(function (result) {
                var categories = result.data.categories || {};
                var registry = result.data.registry || {};
                var offlineMode = result.source === 'cache';
                var allowWrite = opts.allowWrite !== false && navigator.onLine !== false;

                var ordered = Object.keys(registry).sort(function (a, b) {
                    var actA = registry[a] && registry[a].active === false ? 1 : 0;
                    var actB = registry[b] && registry[b].active === false ? 1 : 0;
                    if (actA !== actB) return actA - actB;
                    return (registry[a].label || a).localeCompare(registry[b].label || b);
                });

                var html = '' +
                    '<div class="pref-list-head">' +
                    '<p class="pref-subtitle">Choose which notifications you receive in-app and by email.</p>' +
                    '</div>' +
                    notePanel(result.source) +
                    '<div class="pref-categories">';

                for (var i = 0; i < ordered.length; i++) {
                    var cid = ordered[i];
                    var meta = registry[cid] || {};
                    var enabled = categories[cid] !== false;
                    html += rowHtml(cid, meta, enabled);
                }
                html += '</div>';

                container.innerHTML = html;

                if (offlineMode || !allowWrite) {
                    disableAllToggles(container, offlineMode);
                    return;
                }
                wireToggles(container);
            })
            .catch(function () {
                container.innerHTML = offlinePanel();
            });
    }

    function disableAllToggles(container, showReason) {
        var inputs = container.querySelectorAll('.toggle-switch input');
        for (var i = 0; i < inputs.length; i++) {
            inputs[i].disabled = true;
            if (showReason) inputs[i].title = 'Requires connection';
        }
    }

    function wireToggles(container) {
        container.addEventListener('change', function (event) {
            var input = event.target;
            if (!input || input.type !== 'checkbox' || !input.hasAttribute('data-category')) return;
            var category = input.getAttribute('data-category');
            var enabled = !!input.checked;
            save(category, enabled).catch(function () {
                input.checked = !enabled;
                notify('Could not save this preference. Please try again.');
            });
        });
    }

    // Optimistic server write. On success the cache merges the new state; on
    // failure the cache reverts and the error is rethrown so the UI can undo.
    async function save(category, enabled) {
        var cache = readCache() || { categories: {}, registry: {} };
        var previous = cache.categories ? cache.categories[category] : undefined;
        cache.categories = cache.categories || {};
        cache.categories[category] = enabled;
        writeCache(cache);

        try {
            var result = await TicketAPI.setNotificationCategoryPreference(category, enabled);
            var fresh = readCache() || { categories: {}, registry: cache.registry };
            fresh.categories = (result && result.categories) ? result.categories : fresh.categories;
            fresh.registry = fresh.registry || cache.registry;
            writeCache(fresh);
            try { document.dispatchEvent(new Event('notification-prefs:changed')); } catch (e) { /* noop */ }
            return result;
        } catch (err) {
            cache.categories[category] = previous === undefined ? true : previous;
            writeCache(cache);
            throw err;
        }
    }

    function notify(message) {
        if (typeof window.showToast === 'function') {
            window.showToast(message, 'error', 4000);
        } else {
            try { console.warn(message); } catch (e) { /* noop */ }
        }
    }

    function getCategories() {
        var cache = readCache();
        return cache && cache.categories ? cache.categories : null;
    }

    // Live category registry (cid -> label/icon/role/active) from the last
    // server reply, or null when nothing has been cached yet. Callers that
    // need current labels (bell tabs, admin category manager) refresh via
    // load() first; getRegistry() itself never networks.
    function getRegistry() {
        var cache = readCache();
        return cache && cache.registry ? cache.registry : null;
    }

    function isCategoryEnabled(category) {
        var categories = getCategories();
        if (!categories) return true;
        return categories[category] !== false;
    }

    window.NotificationPrefs = {
        render: render,
        save: save,
        load: load,
        getLastSynced: getLastSynced,
        getCategories: getCategories,
        getRegistry: getRegistry,
        isCategoryEnabled: isCategoryEnabled
    };
})();
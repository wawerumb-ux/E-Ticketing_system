// OfflineDB — shared IndexedDB layer for the User and Admin portals.
//
// DB: ict_offline v2. Object stores:
//   pending_tickets  keyPath: client_uuid  — offline ticket creates (user + admin)
//   pending_comments keyPath: client_uuid  — offline comment creates (user + admin)
//   kv_cache         keyPath: key          — last-good read caches (KB, notifications,
//                                            categories) for durable offline viewing
//
// Queue items are stored as raw request payloads that naturally carry
// client_uuid, plus underscore-prefixed metadata the server ignores but the
// sync loop owns (user, status, attempts, last_error, at). v1 items (legacy
// pending_tickets without metadata) remain readable: they simply have no
// metadata and sync treats them as owned by the current user (one-time
// migration edge — every NEW item is always bound to a username).
(function () {
    'use strict';

    var DB_NAME = 'ict_offline';
    var DB_VERSION = 2;
    var _dbPromise = null;

    function open() {
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise(function (resolve, reject) {
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains('pending_tickets')) {
                    db.createObjectStore('pending_tickets', { keyPath: 'client_uuid' });
                }
                if (!db.objectStoreNames.contains('pending_comments')) {
                    db.createObjectStore('pending_comments', { keyPath: 'client_uuid' });
                }
                if (!db.objectStoreNames.contains('kv_cache')) {
                    db.createObjectStore('kv_cache', { keyPath: 'key' });
                }
            };
            req.onsuccess = function () {
                var db = req.result;
                db.onversionchange = function () { db.close(); };
                resolve(db);
            };
            req.onerror = function () {
                _dbPromise = null;
                reject(req.error);
            };
        });
        return _dbPromise;
    }

    // Runs fn against an object store inside a transaction, resolving with the
    // IDBRequest the call produced (the transaction completes first).
    function withStore(storeName, mode, fn) {
        return open().then(function (db) {
            return new Promise(function (resolve, reject) {
                var t, store, req;
                try {
                    t = db.transaction(storeName, mode);
                    store = t.objectStore(storeName);
                    req = fn(store);
                } catch (e) {
                    reject(e);
                    return;
                }
                t.oncomplete = function () { resolve(req && req.result); };
                t.onerror = function () { reject(t.error); };
                t.onabort = function () { reject(t.error); };
            });
        });
    }

    function ownsItem(item, username) {
        return !item.user || item.user === username;
    }

    window.OfflineDB = {
        // ---- Mutation queue -------------------------------------------------
        enqueue: function (storeName, item, username) {
            var stamped = Object.assign({}, item, {
                user: username || '',
                status: 'pending',
                attempts: 0,
                at: Date.now()
            });
            return withStore(storeName, 'readwrite', function (store) {
                return store.put(stamped);
            });
        },

        getPending: function (storeName, username) {
            return withStore(storeName, 'readonly', function (store) {
                return store.getAll();
            }).then(function (items) {
                return (items || []).filter(function (i) { return ownsItem(i, username); });
            });
        },

        remove: function (storeName, key) {
            return withStore(storeName, 'readwrite', function (store) {
                return store.delete(key);
            });
        },

        patch: function (storeName, key, patch) {
            return withStore(storeName, 'readwrite', function (store) {
                var get = store.get(key);
                get.onsuccess = function () {
                    var current = get.result || {};
                    store.put(Object.assign({}, current, patch));
                };
                return get;
            });
        },

        count: function (storeName) {
            return withStore(storeName, 'readonly', function (store) {
                return store.count();
            });
        },

        // ---- Read cache (durable last-good data) ----------------------------
        cachePut: function (key, data, username) {
            return withStore('kv_cache', 'readwrite', function (store) {
                return store.put({ key: key, data: data, at: Date.now(), user: username || '' });
            });
        },

        cacheGet: function (key) {
            return withStore('kv_cache', 'readonly', function (store) {
                return store.get(key);
            });
        },

        cacheDel: function (key) {
            return withStore('kv_cache', 'readwrite', function (store) {
                return store.delete(key);
            });
        },

        // ---- Whole-database reset (danger zone / logout hygiene) -------------
        deleteDb: function () {
            _dbPromise = null;
            return new Promise(function (resolve) {
                try {
                    var req = indexedDB.deleteDatabase(DB_NAME);
                    req.onsuccess = function () { resolve(); };
                    req.onerror = function () { resolve(); };
                    req.onblocked = function () { resolve(); };
                } catch (e) { resolve(); }
            });
        }
    };
})();
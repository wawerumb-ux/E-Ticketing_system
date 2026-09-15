// LIVE EVENTS CLIENT (SSE)
// Connects to the backend /api/events/stream via EventSource. EventSource can't
// send Authorization headers, so the short-lived access token is passed as a
// query parameter and verified server-side. On disconnect it retries with a
// backoff. All events are also forwarded as DOM CustomEvents ("live:event").
const LiveEvents = {
    _es: null,
    _failures: 0,
    _lastId: 0,
    _refreshing: false,
    _refreshed: false,
    handlers: {},
    connect() {
        const token = AuthAPI.getAccessToken();
        if (!token || this._es) return;
        if (this._isExpired(token)) { this._refreshAndRetry(); return; }
        const params = new URLSearchParams({ token });
        if (this._lastId) params.set('last_id', this._lastId);
        const es = new EventSource(`${API_BASE_URL}/events/stream?${params.toString()}`);

        es.addEventListener('ticket.created', (e) => this._handleEvent(e));
        es.addEventListener('ticket.updated', (e) => this._handleEvent(e));
        es.addEventListener('comment.created', (e) => this._handleEvent(e));
        es.addEventListener('attachment.created', (e) => this._handleEvent(e));
        es.addEventListener('announcement', (e) => this._handleEvent(e));

        es.addEventListener('open', () => { this._failures = 0; this._refreshed = false; });

        es.onerror = () => {
            es.close();
            this._es = null;
            if (this._isExpired(token)) { this._refreshAndRetry(); return; }
            if (!this._refreshed) {
                this._refreshed = true;
                this._refreshAndRetry();
                return;
            }
            if (navigator.onLine === false) {
                this._failures++;
                const delay = Math.min(5000 * Math.pow(2, this._failures - 1), 60000);
                setTimeout(() => this.connect(), delay);
            }
        };
        this._es = es;
    },
    _refreshAndRetry() {
        if (this._refreshing) return;
        this._refreshing = true;
        AuthAPI.refreshToken()
            .then(() => { this._refreshing = false; this.connect(); })
            .catch(() => {
                this._refreshing = false;
                if (navigator.onLine === false) {
                    this._failures++;
                    const delay = Math.min(5000 * Math.pow(2, this._failures - 1), 60000);
                    setTimeout(() => this.connect(), delay);
                }
            });
    },
    _isExpired(token) {
        try {
            const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const payload = JSON.parse(atob(part));
            return payload.exp != null && payload.exp * 1000 < Date.now();
        } catch (e) { return false; }
    },
    reconnect() {
        if (this._es) {
            this._es.close();
            this._es = null;
        }
        this._failures = 0;
        this.connect();
    },
    _emit(type, raw) {
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { /* ignore malformed payload */ }
        document.dispatchEvent(new CustomEvent('live:event', { detail: { type, data } }));
        (this.handlers[type] || []).forEach(fn => fn(data));
    },
    _handleEvent(e) {
        if (e.lastEventId) {
            const id = parseInt(e.lastEventId, 10);
            if (!isNaN(id) && id > this._lastId) this._lastId = id;
        }
        this._emit(e.type, e.data);
    },
    on(type, fn) {
        (this.handlers[type] = this.handlers[type] || []).push(fn);
    }
};

document.addEventListener('DOMContentLoaded', () => LiveEvents.connect());
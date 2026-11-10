const CONNECTION_HEARTBEAT_MS = 30000;
const CONNECTION_DEGRADED_LATENCY_MS = 3000;

const ConnectionStatus = {
    _state: 'online',
    _offline: false,
    _syncing: false,
    _latencyMs: 0,
    _lastSync: 0,
    _lastHealthOk: true,
    _heartbeatInFlight: false,
    _heartbeatTimer: null,
    _listeners: [],
    _boundOnline: null,
    _boundOffline: null,

    start() {
        if (this._heartbeatTimer) return;
        this._boundOnline = () => { this._offline = false; this._setState('online'); this._heartbeat(); };
        this._boundOffline = () => { this._offline = true; this._setState('offline'); };
        window.addEventListener('online', this._boundOnline);
        window.addEventListener('offline', this._boundOffline);
        this._heartbeat();
        this._heartbeatTimer = setInterval(() => this._heartbeat(), CONNECTION_HEARTBEAT_MS);
    },

    stop() {
        window.removeEventListener('online', this._boundOnline);
        window.removeEventListener('offline', this._boundOffline);
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
    },

    setSyncing(value) {
        this._syncing = value ? true : false;
        this._setState(this._resolve());
    },

    retry() {
        this._heartbeat();
    },

    getState() {
        const snapshot = { state: this._state, lastSync: this._lastSync, retry: () => this.retry() };
        snapshot.label = this._labels[this._state] || this._labels.online;
        return snapshot;
    },

    onStateChange(fn) {
        this._listeners.push(fn);
        return () => { this._listeners = this._listeners.filter((f) => f !== fn); };
    },

    _labels: { online: 'Online', syncing: 'Syncing', offline: 'Offline', degraded: 'Degraded' },

    _resolve() {
        if (this._syncing) return 'syncing';
        if (this._offline) return 'offline';
        if (this._lastHealthOk === false || this._latencyMs > CONNECTION_DEGRADED_LATENCY_MS) return 'degraded';
        return 'online';
    },

    _setState(state) {
        this._state = state;
        const snapshot = { state: this._state, lastSync: this._lastSync, retry: () => this.retry() };
        snapshot.label = this._labels[this._state] || this._labels.online;
        this._listeners.forEach((fn) => fn(snapshot));
    },

    _heartbeat() {
        if (this._heartbeatInFlight) return;
        this._heartbeatInFlight = true;
        const now = () => (window.performance && typeof window.performance.now === 'function') ? window.performance.now() : Date.now();
        const startedAt = now();
        fetch(`${API_BASE_URL}/health`, { cache: 'no-store' })
            .then((res) => {
                const endedAt = now();
                this._latencyMs = Math.round(endedAt - startedAt);
                this._lastSync = Date.now();
                this._lastHealthOk = res.ok;
                this._setState(this._resolve());
            })
            .catch(() => {
                this._latencyMs = 0;
                this._lastSync = Date.now();
                this._lastHealthOk = false;
                this._setState(this._resolve());
            })
            .then(() => { this._heartbeatInFlight = false; });
    }
};

document.addEventListener('DOMContentLoaded', () => ConnectionStatus.start());

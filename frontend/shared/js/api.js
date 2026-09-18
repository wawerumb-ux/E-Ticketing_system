 // API Configuration
// The API is served by the same Flask app. On LAN it's reachable at hostname:5000.
// Through a tunnel (ngrok) the whole app is on one URL with no extra port, so we
// detect that case and use the current page origin directly.
const IS_TUNNEL = window.location.port === '' || /\.ngrok-(free\.)?(app|dev|io)$|\.loca\.lt$/.test(window.location.hostname);const API_BASE_URL = IS_TUNNEL
    ? `${window.location.origin}/api`
    : `${window.location.protocol}//${window.location.hostname}:5000/api`;

// ============ AUTH TOKEN MANAGEMENT ============
// Tokens are kept in sessionStorage rather than localStorage: cleared when the
// tab closes, not persisted indefinitely. Still JS-readable (not immune to XSS) —
// httpOnly cookies would be stronger but require backend cookie/CSRF work not yet done.
// CSRF protection is implemented via double-submit cookie pattern.
const AuthAPI = {
    getAccessToken() {
        return sessionStorage.getItem('access_token');
    },
    getRefreshToken() {
        return sessionStorage.getItem('refresh_token');
    },
    setTokens(access, refresh) {
        sessionStorage.setItem('access_token', access);
        if (refresh) sessionStorage.setItem('refresh_token', refresh);
    },
    clearTokens() {
        sessionStorage.removeItem('access_token');
        sessionStorage.removeItem('refresh_token');
    },
    getTurnstileToken() {
        if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
            return window.turnstile.getResponse() || '';
        }
        return '';
    },
     async login(username, password) {
        const response = await fetch(`${API_BASE_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, turnstile_token: this.getTurnstileToken() })
        });
        if (!response.ok) {
            let errMsg = 'Login failed';
            try {
                const err = await response.json();
                errMsg = err.error || errMsg;
            } catch (e) {
                const text = await response.text();
                if (response.status === 429) {
                    errMsg = 'Too many login attempts. Please wait a moment and try again.';
                } else if (text) {
                    errMsg = `Request failed (${response.status})`;
                }
            }
            throw new Error(errMsg);
        }
        const data = await response.json();
        if (data.needs_2fa) {
            sessionStorage.setItem('pending_token', data.pending_token);
            return { needs2fa: true, user: data.user };
        }
        sessionStorage.removeItem('pending_token');
        this.setTokens(data.access_token, data.refresh_token);
        sessionStorage.setItem('current_user', JSON.stringify(data.user));
        return data.user;
    },
   async login2fa(code) {
        const pendingToken = sessionStorage.getItem('pending_token');
        if (!pendingToken) throw new Error('Session expired, please sign in again');
        const response = await fetch(`${API_BASE_URL}/auth/verify-2fa`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pending_token: pendingToken, code })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Invalid verification code');
        sessionStorage.removeItem('pending_token');
        this.setTokens(data.access_token, data.refresh_token);
        sessionStorage.setItem('current_user', JSON.stringify(data.user));
        return data.user;
    },
  async register(username, email, password, name) {
        const response = await fetch(`${API_BASE_URL}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password, name })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Registration failed');
        return data;
    },
    async forgotPassword(email) {
        const response = await fetch(`${API_BASE_URL}/auth/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Request failed');
        return data;
    },
    async resetPassword(token, password) {
        const response = await fetch(`${API_BASE_URL}/auth/reset-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, password, turnstile_token: this.getTurnstileToken() })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Reset failed');
        return data;
    },
    getCurrentUser() {
        const raw = sessionStorage.getItem('current_user');
        return raw ? JSON.parse(raw) : null;
    },
    logout() {
        this.clearTokens();
        sessionStorage.removeItem('current_user');
        window.location.href = '/login';
    },
    // Refresh the access token with the existing refresh-token flow. Stores the
    // new access token and returns it. Throws if the refresh token is unusable.
    // The backend reads refresh JWTs from the Authorization header (flask-jwt-extended
    // default token location is headers).
    async refreshToken() {
        const refreshToken = this.getRefreshToken();
        if (!refreshToken) throw new Error('Session expired, please log in again');
        const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${refreshToken}` }
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || data.msg || 'Session expired, please log in again');
        this.setTokens(data.access_token, refreshToken);
        return data.access_token;
    },
    requireAuth() {
        if (!this.getAccessToken()) {
            window.location.href = '/login';
        }
    },
    // Session-expiry handling. An expired/revoked token must never, by itself,
    // trigger a logout+redirect — that is reserved for the explicit logout
    // controls. Instead the rejection is surfaced to the registerable callback
    // (per portal) which presents the "Session expired" dialog. Tokens are
    // cleared here because the server already rejected them; the user stays on
    // the page (history/back stays intact) until they choose to go to login.
    _handleSessionExpired() {
        sessionStorage.removeItem('access_token');
        sessionStorage.removeItem('refresh_token');
        this._sessionExpiredFired = true;
        if (typeof this._sessionExpiredCallback === 'function') {
            this._sessionExpiredCallback();
        }
    },
    onSessionExpired() {
        if (!this._sessionExpiredFired) this._handleSessionExpired();
    },
    setOnSessionExpired(callback) {
        this._sessionExpiredCallback = callback;
        this._sessionExpiredFired = false;
    }
};
    


function authHeader() {
    const token = AuthAPI.getAccessToken();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
}

function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
    return match ? match[1] : null;
}

// One refresh at a time: while a refresh is in flight, concurrent 422/401
// responses (e.g. a burst of expired-token requests) share the same promise
// instead of stampeding /api/auth/refresh.
let _refreshing = null;
async function _refreshAccessTokenOnce() {
    if (_refreshing) return _refreshing;
    _refreshing = AuthAPI.refreshToken()
        .then((token) => { _refreshing = null; return token; })
        .catch((error) => { _refreshing = null; throw error; });
    return _refreshing;
}

// Wraps fetch: attaches the bearer token and CSRF token.
// flask-jwt-extended answers 422 (not 401) for a missing/expired/invalid
// access token, so on either status we try one silent refresh+retry before
// giving up. If the refresh fails (or the retried request is rejected with
// 401) the session is genuinely expired: auth tokens are cleared and the
// registered onSessionExpired callback (the portal's "Session expired" dialog)
// is invoked. No forced logout or redirect happens here — navigation is never
// what logs a user out.
// Options may carry noAuthRedirect: true to suppress refresh and the expiry
// path so a caller (e.g. the offline queue) can classify the 401/422 itself.
async function apiFetch(url, options = {}) {
    options.headers = { ...(options.headers || {}), ...authHeader() };
    const method = (options.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'DELETE'].includes(method)) {
        const csrf = getCsrfToken();
        if (csrf) options.headers['X-CSRF-Token'] = csrf;
    }
    let response = await fetch(url, options);

    if (!options.noAuthRedirect && (response.status === 401 || response.status === 422)) {
        try {
            await _refreshAccessTokenOnce();
        } catch (error) {
            AuthAPI.onSessionExpired();
            throw new Error('Session expired, please log in again');
        }
        // Re-attach the fresh access token, then retry the original request once.
        options.headers = { ...(options.headers || {}), ...authHeader() };
        response = await fetch(url, options);
        if (response.status === 401) {
            AuthAPI.onSessionExpired();
            throw new Error('Session expired, please log in again');
        }
        // A repeated 422 after a successful refresh is a genuine server
        // rejection — surface it to the caller, do not trigger expiry.
    }
    if (response.status === 401 && !options.noAuthRedirect) {
        AuthAPI.onSessionExpired();
        throw new Error('Session expired, please log in again');
    }
    return response;
}

// ============ API FUNCTIONS ============
class TicketAPI {
    static async updateUser(id, userData) {
    const response = await apiFetch(`${API_BASE_URL}/users/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userData)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to update user');
    return data;
    }
    static async getTickets() {
        try {
            const response = await apiFetch(`${API_BASE_URL}/tickets`);
            if (!response.ok) throw new Error('Failed to fetch tickets');
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return [];
        }    
    }
    // Like getTickets but reports whether the response was served from the
    // service worker cache (X-ICT-Cache: hit) so the UI can stay honest about
    // data freshness instead of stamping "last synced" on cached data.
    static async getTicketsWithMeta() {
        try {
            const response = await apiFetch(`${API_BASE_URL}/tickets`);
            if (!response.ok) return { tickets: [], ok: false, fromCache: false };
            const fromCache = response.headers.get('X-ICT-Cache') === 'hit';
            const tickets = await response.json();
            return { tickets, ok: true, fromCache };
        } catch (error) {
            console.error('API Error:', error);
            return { tickets: [], ok: false, fromCache: false };
        }
    }
    static async getMyProfile() {
    try {
        const response = await apiFetch(`${API_BASE_URL}/users/me`);
        if (!response.ok) throw new Error('Failed to fetch profile');
        return await response.json();
    } catch (error) {
        console.error('API Error:', error);
        return null;
    }
}

    static async changePassword(currentPassword, newPassword) {
        const response = await apiFetch(`${API_BASE_URL}/users/me/password`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to change password');
        return data;
}
    // Self-service username rename. The backend verifies the current password
    // and returns fresh tokens, so the caller must swap them into sessionStorage
    // (AuthAPI.setTokens) for the new username to be recognised immediately.
    static async changeUsername(newUsername, currentPassword) {
        const response = await apiFetch(`${API_BASE_URL}/users/me/username`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: newUsername, password: currentPassword })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to change username');
        AuthAPI.setTokens(data.access_token, data.refresh_token);
        if (data.user) sessionStorage.setItem('current_user', JSON.stringify(data.user));
        return data;
}
    static async createTicket(ticketData) {
        const response = await apiFetch(`${API_BASE_URL}/tickets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ticketData)
        });
        if (!response.ok) throw new Error('Failed to create ticket');
        return await response.json();
    }

    // Generates a client-side UUID for idempotent offline replay. crypto.randomUUID
    // is unavailable on non-secure origins, so fall back to a RFC-ish v4 string.
    static generateClientUuid() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        const bytes = typeof crypto !== 'undefined' && crypto.getRandomValues
            ? crypto.getRandomValues(new Uint8Array(16))
            : Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    static attachClientUuid(payload) {
        if (!payload.client_uuid) payload.client_uuid = TicketAPI.generateClientUuid();
        return payload;
    }

    // Offline-aware create that distinguishes network failures (retryable:
    // queue locally) from HTTP errors (the server rejected the request — do not
    // silently queue). Returns { ok, status, network, data?, error? }.
    static async createTicketOffline(payload) {
        TicketAPI.attachClientUuid(payload);
        let response;
        try {
            response = await apiFetch(`${API_BASE_URL}/tickets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                noAuthRedirect: true
            });
        } catch (error) {
            // fetch() threw before we got an HTTP response (offline, DNS, refused) —
            // this is a network failure, safe to queue and retry later.
            return { ok: false, network: true, status: 0, error };
        }
        let data = {};
        try {
            data = await response.json();
        } catch (error) {
            data = {};
        }
        if (!response.ok) {
            return { ok: false, network: false, status: response.status, data, error: new Error(data.error || 'Failed to create ticket') };
        }
        return { ok: true, status: response.status, data };
    }

    static async updateTicket(id, ticketData) {
        const response = await apiFetch(`${API_BASE_URL}/tickets/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ticketData)
        });
        if (!response.ok) throw new Error('Failed to update ticket');
        return await response.json();
    }

    static async deleteTicket(id) {
        const response = await apiFetch(`${API_BASE_URL}/tickets/${id}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to delete ticket');
        return await response.json();
    }

    static async getDashboardStats() {
        try {
            const response = await apiFetch(`${API_BASE_URL}/dashboard/stats`);
            if (!response.ok) throw new Error('Failed to fetch stats');
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return null;
        }
    }

    static async getUsers(filters = {}) {
        try {
            const params = new URLSearchParams();
            if (filters.q) params.set('q', filters.q);
            if (filters.role && filters.role !== 'all') params.set('role', filters.role);
            if (filters.status && filters.status !== 'all') params.set('status', filters.status);
            if (filters.department && filters.department !== 'all') params.set('department', filters.department);
            const qs = params.toString();
            const url = qs ? `${API_BASE_URL}/users?${qs}` : `${API_BASE_URL}/users`;
            const response = await apiFetch(url);
            if (!response.ok) throw new Error('Failed to fetch users');
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return [];
        }
    }

    static async createUser(userData) {
        const response = await apiFetch(`${API_BASE_URL}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(userData)
        });
        if (!response.ok) throw new Error('Failed to create user');
        return await response.json();
    }

    static async deleteUser(id) {
        const response = await apiFetch(`${API_BASE_URL}/users/${id}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to delete user');
        return await response.json();
    }

    static async purgeUser(id) {
        const response = await apiFetch(`${API_BASE_URL}/users/${id}/permanent`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to permanently delete user');
        return await response.json();
    }

    static async getKnowledgeArticles(query = '', category = 'all') {
        const result = await TicketAPI.getKnowledgeArticlesWithMeta(query, category);
        return result.articles;
    }

    // The KB loader's twin that keeps the outage honest. Where the cache is a
    // service-worker network-first read, an offline + never-cached visit must
    // surface "requires connection" instead of a false "No articles match your
    // search." — a search-empty lie is not a result.
    static async getKnowledgeArticlesWithMeta(query = '', category = 'all') {
        try {
            const params = new URLSearchParams();
            if (query) params.set('q', query);
            if (category && category !== 'all') params.set('category', category);
            const response = await apiFetch(`${API_BASE_URL}/kb/articles?${params.toString()}`);
            const fromCache = response.headers.get('X-ICT-Cache') === 'hit';
            if (!response.ok) return { articles: [], ok: false, fromCache };
            return { articles: await response.json(), ok: true, fromCache };
        } catch (error) {
            console.error('API Error:', error);
            return { articles: [], ok: false, fromCache: false };
        }
    }
    static async getNotifications() {
    try {
        const response = await apiFetch(`${API_BASE_URL}/notifications`);
        if (!response.ok) throw new Error('Failed to fetch notifications');
        return await response.json();
    } catch (error) {
        console.error('API Error:', error);
        return { notifications: [], unread_count: 0 };
    }

    
}

static async markNotificationRead(id) {
    const response = await apiFetch(`${API_BASE_URL}/notifications/${id}/read`, { method: 'PUT' });
    if (!response.ok) throw new Error('Failed to mark notification read');
    return await response.json();
}

static async markAllNotificationsRead() {
    const response = await apiFetch(`${API_BASE_URL}/notifications/read-all`, { method: 'PUT' });
    if (!response.ok) throw new Error('Failed to mark all read');
    return await response.json();
}
static async getTicketComments(ticketId) {
    try {
        const response = await apiFetch(`${API_BASE_URL}/tickets/${ticketId}/comments`);
        if (!response.ok) throw new Error('Failed to fetch comments');
        return await response.json();
    } catch (error) {
        console.error('API Error:', error);
        return [];
    }
}

static async createTicketComment(ticketId, message, isInternal = false) {
    const response = await apiFetch(`${API_BASE_URL}/tickets/${ticketId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, is_internal: isInternal })
    });
    if (!response.ok) throw new Error('Failed to post comment');
    return await response.json();
}

// Offline-aware comment create: attaches a client_uuid and classifies the
// outcome exactly like createTicketOffline — network failure (retryable:
// queue locally) vs HTTP rejection (the server refused — do not auto-retry).
// The server dedups the same client_uuid and returns 200 with the existing
// comment, so a queued comment can only ever land once.
static async createTicketCommentOffline(ticketId, message, isInternal = false, clientUuid = null) {
    const payload = { message, is_internal: isInternal };
    // Keep the uuid the page already stamped on the queued item (if any) so a
    // replay uses the SAME uuid as the original attempt — the server dedups on
    // it, so a comment that committed but whose reply was lost cannot duplicate.
    if (clientUuid) payload.client_uuid = clientUuid;
    TicketAPI.attachClientUuid(payload);
    let response;
    try {
        response = await apiFetch(`${API_BASE_URL}/tickets/${ticketId}/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            noAuthRedirect: true
        });
    } catch (error) {
        return { ok: false, network: true, status: 0, error };
    }
    let data = {};
    try { data = await response.json(); } catch (error) { data = {}; }
    if (!response.ok) {
        return { ok: false, network: false, status: response.status, data, error: new Error(data.error || 'Failed to post comment') };
    }
    return { ok: true, status: response.status, data };
}

    static async reactivateUser(id) {
        const response = await apiFetch(`${API_BASE_URL}/users/${id}/reactivate`, { method: 'PUT' });
        if (!response.ok) throw new Error('Failed to reactivate user');
        return await response.json();
    }

    static async getCategories() {
        try {
            const response = await apiFetch(`${API_BASE_URL}/categories`);
            if (!response.ok) throw new Error('Failed to fetch categories');
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return [];
        }
    }

    static async createCategory(name) {
        const response = await apiFetch(`${API_BASE_URL}/categories`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to create category');
        return data;
    }

    static async deleteCategory(id) {
        const response = await apiFetch(`${API_BASE_URL}/categories/${id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Failed to remove category');
        return await response.json();
    }

    static async getRoles() {
        try {
            const response = await apiFetch(`${API_BASE_URL}/roles`);
            if (!response.ok) throw new Error('Failed to fetch roles');
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return [];
        }
    }

    static async createRole(name) {
        const response = await apiFetch(`${API_BASE_URL}/roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to create role');
        return data;
    }

    static async deactivateRole(id) {
        const response = await apiFetch(`${API_BASE_URL}/roles/${id}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to deactivate role');
        return data;
    }

    static async getDepartments() {
        try {
            const response = await apiFetch(`${API_BASE_URL}/departments`);
            if (!response.ok) throw new Error('Failed to fetch departments');
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return [];
        }
    }

    static async createDepartment(name) {
        const response = await apiFetch(`${API_BASE_URL}/departments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to create department');
        return data;
    }

    static async deleteDepartment(id) {
        const response = await apiFetch(`${API_BASE_URL}/departments/${id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Failed to remove department');
        return await response.json();
    }

    static async getAuditLogs(entity = '', action = '') {
        try {
            const params = new URLSearchParams();
            if (entity) params.set('entity', entity);
            if (action) params.set('action', action);
            const response = await apiFetch(`${API_BASE_URL}/audit/logs?${params.toString()}`);
            if (!response.ok) throw new Error('Failed to fetch audit logs');
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return [];
        }
    }

    static async getAttachments(ticketId) {
        // Throws on HTTP/network failure so the UI can render an honest error
        // instead of mistaking a failed fetch for an empty attachment list.
        const response = await apiFetch(`${API_BASE_URL}/tickets/${ticketId}/attachments`);
        if (!response.ok) throw new Error('Failed to fetch attachments');
        return await response.json();
    }

    static async uploadAttachment(ticketId, file, onProgress) {
        const formData = new FormData();
        formData.append('file', file);
        const response = await apiFetch(`${API_BASE_URL}/tickets/${ticketId}/attachments`, {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Upload failed');
        return data;
    }

    static async deleteAttachment(attachmentId) {
        const response = await apiFetch(`${API_BASE_URL}/attachments/${attachmentId}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Failed to delete attachment');
        return await response.json();
    }

    static async downloadAttachment(attachment, onError) {
        try {
            const response = await apiFetch(`${API_BASE_URL}/attachments/${attachment.id}/download`);
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                if (onError) onError(data.error || 'Download failed');
                return false;
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = attachment.original_filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            return true;
        } catch (err) {
            if (onError) onError(err.message || 'Download failed');
            return false;
        }
    }

    static async getSettings() {
        try {
            const response = await apiFetch(`${API_BASE_URL}/settings`);
            if (!response.ok) throw new Error('Failed to fetch settings');
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return null;
        }
    }

    static async updateSettings(settings) {
        const response = await apiFetch(`${API_BASE_URL}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to update settings');
        return data;
    }

    static async getReportSummary(from = '', to = '') {
        try {
            const params = new URLSearchParams();
            if (from) params.set('from', from);
            if (to) params.set('to', to);
            const response = await apiFetch(`${API_BASE_URL}/reports/summary?${params.toString()}`);
            if (!response.ok) throw new Error('Failed to fetch report');
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return null;
        }
    }

    static async downloadReportCSV(scope, from = '', to = '', onError) {
        try {
            const params = new URLSearchParams();
            if (from) params.set('from', from);
            if (to) params.set('to', to);
            const response = await apiFetch(`${API_BASE_URL}/reports/export/${scope}.csv?${params.toString()}`);
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                if (onError) onError(data.error || 'Export failed');
                return false;
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${scope}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            return true;
        } catch (err) {
            if (onError) onError(err.message || 'Export failed');
            return false;
        }
    }

    static async getKbArticle(id) {
        try {
            const response = await apiFetch(`${API_BASE_URL}/kb/articles/${id}`);
            if (!response.ok) throw new Error('Failed to fetch article');
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return null;
        }
    }

    static async createKbArticle(article) {
        const response = await apiFetch(`${API_BASE_URL}/kb/articles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(article)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to create article');
        return data;
    }

    static async updateKbArticle(id, article) {
        const response = await apiFetch(`${API_BASE_URL}/kb/articles/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(article)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to update article');
        return data;
    }

    static async deleteKbArticle(id) {
        const response = await apiFetch(`${API_BASE_URL}/kb/articles/${id}`, {
            method: 'DELETE'
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to delete article');
        return data;
    }

    static async broadcastNotification(payload) {
        const response = await apiFetch(`${API_BASE_URL}/notifications/broadcast`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to send broadcast');
        return data;
    }

    static async getNotificationPreferences() {
        try {
            const response = await apiFetch(`${API_BASE_URL}/notifications/preferences`);
            if (!response.ok) throw new Error('Failed to fetch preferences');
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return { email_enabled: true, in_app_enabled: true };
        }
    }

    static async updateNotificationPreferences(prefs) {
        const response = await apiFetch(`${API_BASE_URL}/notifications/preferences`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(prefs)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to update preferences');
        return data;
    }

    static async getNotificationCategoryPreferences() {
        try {
            const response = await apiFetch(`${API_BASE_URL}/users/me/notification-preferences`);
            if (!response.ok) throw new Error('Failed to fetch category preferences');
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return null;
        }
    }

    static async setNotificationCategoryPreference(category, enabled) {
        const response = await apiFetch(`${API_BASE_URL}/users/me/notification-preferences`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category, enabled })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to update preference');
        return data;
    }

    static async get2FAStatus() {
        try {
            const response = await apiFetch(`${API_BASE_URL}/auth/2fa`);
            if (!response.ok) throw new Error('Failed to fetch 2FA status');
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return { enabled: false };
        }
    }

    static async setup2FA() {
        const response = await apiFetch(`${API_BASE_URL}/auth/2fa/setup`, { method: 'POST' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to start setup');
        return data;
    }

    static async verify2FASetup(code) {
        const response = await apiFetch(`${API_BASE_URL}/auth/2fa/setup/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Invalid verification code');
        return data;
    }

    static async disable2FA(code) {
        const response = await apiFetch(`${API_BASE_URL}/auth/2fa/disable`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Invalid verification code');
        return data;
    }

    static async resetUser2FA(id) {
        const response = await apiFetch(`${API_BASE_URL}/users/${id}/reset-2fa`, { method: 'POST' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to reset 2FA');
        return data;
    }

    static async getApiTokens() {
        try {
            const response = await apiFetch(`${API_BASE_URL}/tokens`);
            if (!response.ok) throw new Error('Failed to fetch tokens');
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return [];
        }
    }

    static async createApiToken(payload) {
        const response = await apiFetch(`${API_BASE_URL}/tokens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to create token');
        return data;
    }

    static async revokeApiToken(id) {
        const response = await apiFetch(`${API_BASE_URL}/tokens/${id}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to revoke token');
        return data;
    }

    static async getWebhooks() {
        try {
            const response = await apiFetch(`${API_BASE_URL}/webhooks`);
            if (!response.ok) throw new Error('Failed to fetch webhooks');
            return await response.json();
        } catch (error) {
            console.error('API Error:', error);
            return [];
        }
    }

    static async createWebhook(payload) {
        const response = await apiFetch(`${API_BASE_URL}/webhooks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to create webhook');
        return data;
    }

    static async updateWebhook(id, payload) {
        const response = await apiFetch(`${API_BASE_URL}/webhooks/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to update webhook');
        return data;
    }

    static async deleteWebhook(id) {
        const response = await apiFetch(`${API_BASE_URL}/webhooks/${id}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to delete webhook');
        return data;
    }
}
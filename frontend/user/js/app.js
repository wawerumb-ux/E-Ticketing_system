 // User Portal Application Logic
var SETTINGS_KEY = 'settings';
const THEME_REGISTRY = {
    'daylight': 'light',
    'quiet-light': 'light',
    'solarized-light': 'light',
    'abyss': 'dark',
    'night-owl': 'dark',
    'high-contrast': 'dark',
    'flexoki-light': 'light',
    'catppuccin-latte': 'light',
    'catppuccin-mocha': 'dark',
    'nord': 'dark',
    'gruvbox': 'dark'
};
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
const SECTION_TITLES = {
    dashboard: 'Dashboard',
    tickets: 'All Tickets',
    create: 'Create Ticket',
    knowledge: 'Knowledge Base',
    profile: 'My Profile',
    settings: 'Settings'
};
class TicketingApp {
    constructor() {
        AuthAPI.requireAuth();
        this.currentUser = AuthAPI.getCurrentUser();
        this.currentSection = 'dashboard';
        this.tickets = [];
        this.filteredTickets = [];
        this.sortField = 'created_at';
        this.sortDirection = 'desc';
        this.currentPage = 1;
        this.pageSize = 10;
        this.activeTicketAttachments = [];
        this.syncing = false;
        this.notifications = [];
        this.notificationUnread = 0;
        this.notificationsOffline = false;
        this.notificationFilter = 'all';
        this.init();
    }

    async init() {
        this.applySettings();
        this.applyTheme();
        this.applyFocusMode();
        this.renderIdentity();
        window.showToast = (message, type) => this.showToast(message, type === 'error');
        this.setupEventListeners();
        this.renderWelcome();
        await this.loadTickets();
        this.renderPersonalDashboard();
        await this.loadNotifications();
        await this.loadCategoryOptions();
        this.setupLiveEvents();
        this.setupOfflineSync();
        this.initSessionExpiredDialog();
        // Section routing: honor a hash on load (reload/bookmark) or land on
        // the default section. The landing hash is installed with
        // replaceState so the browser keeps a single in-app entry at the
        // start of the session's history — back from the first section then
        // leaves the app instead of ever looking like a logout.
        this.initSectionRouting();
    }

    setupLiveEvents() {
        if (typeof LiveEvents === 'undefined') return;
        let reloadTimer = null;
        const reloadTickets = () => {
            if (this.currentSection !== 'tickets' && this.currentSection !== 'dashboard') return;
            if (reloadTimer) return;
            reloadTimer = setTimeout(() => {
                reloadTimer = null;
                if (this.currentSection === 'tickets' || this.currentSection === 'dashboard') this.loadTickets();
            }, 500);
        };
        LiveEvents.on('ticket.created', reloadTickets);
        LiveEvents.on('ticket.updated', reloadTickets);
        LiveEvents.on('comment.created', reloadTickets);
        LiveEvents.on('comment.created', () => this.loadNotifications());
        LiveEvents.on('ticket.updated', () => this.loadNotifications());
        LiveEvents.on('announcement', () => this.loadNotifications());
    }

    renderWelcome() {
        const eff = this.getEffectiveProfile();
        const name = eff.displayName || eff.username || 'there';
        document.getElementById('welcomeMessage').textContent = `Welcome back, ${name}!`;
    }

    setupEventListeners() {
        document.addEventListener('notification-prefs:changed', () => {
            const visible = this.visibleNotifications();
            const visibleUnread = visible.filter(n => !n.is_read).length;
            this.renderNotificationBadge(visibleUnread);
            this.renderNotificationList();
        });

        document.querySelectorAll('.sidebar-nav li').forEach(item => {
            item.addEventListener('click', () => this.switchSection(item.dataset.section));
        });

        document.getElementById('focusModeToggleBtn').addEventListener('click', () => this.toggleFocusMode());

        document.getElementById('ticketForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleTicketSubmit(e);
        });

        document.getElementById('statusFilter').addEventListener('change', () => this.filterTickets());
        document.getElementById('priorityFilter').addEventListener('change', () => this.filterTickets());
        document.getElementById('searchTicket').addEventListener('input', () => this.filterTickets());

        document.getElementById('logoutBtn').addEventListener('click', () => AuthAPI.logout());

        document.getElementById('quickReportIssue').addEventListener('click', () => this.switchSection('create'));
        document.getElementById('quickViewTickets').addEventListener('click', () => this.switchSection('tickets'));

        document.getElementById('closeTicketDetail').addEventListener('click', () => {
            document.getElementById('ticketDetailModal').style.display = 'none';
        });

        window.addEventListener('click', (e) => {
            if (e.target === document.getElementById('ticketDetailModal')) {
                document.getElementById('ticketDetailModal').style.display = 'none';
            }
        });

        document.querySelectorAll('#tickets th[data-sort]').forEach(th => {
            th.addEventListener('click', () => this.handleSort(th.dataset.sort));
        });

        document.getElementById('quickKnowledgeBase').addEventListener('click', () => this.switchSection('knowledge'));
        document.getElementById('kbSearch').addEventListener('input', () => this.loadKnowledgeArticles());
        document.getElementById('kbCategoryFilter').addEventListener('change', () => this.loadKnowledgeArticles());

        document.getElementById('notificationBell').addEventListener('click', () => this.toggleNotificationDropdown());

        window.addEventListener('click', (e) => {
            const bell = document.getElementById('notificationBell');
            const dropdown = document.getElementById('notificationDropdown');
            if (dropdown.style.display === 'block' && !bell.contains(e.target) && !dropdown.contains(e.target)) {
                dropdown.style.display = 'none';
                bell.setAttribute('aria-expanded', 'false');
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const bell = document.getElementById('notificationBell');
            const dropdown = document.getElementById('notificationDropdown');
            if (dropdown.style.display === 'block') {
                dropdown.style.display = 'none';
                if (bell) {
                    bell.setAttribute('aria-expanded', 'false');
                    bell.focus();
                }
            }
        });

        this.initThemePicker();
        document.getElementById('passwordForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handlePasswordChange(e);
        });
        // Show/hide the current-password guard when the username field changes.
        document.getElementById('accountInfo').addEventListener('input', (e) => {
            if (e.target && e.target.id === 'infoUsername') this.refreshUsernameGuard();
        });
        document.getElementById('prefEmail').addEventListener('change', () => this.savePrefs());
        document.getElementById('prefInApp').addEventListener('change', () => this.savePrefs());
        window.addEventListener('offline', () => {
            this.notificationsOffline = true;
            const dropdown = document.getElementById('notificationDropdown');
            if (dropdown && dropdown.style.display === 'block') this.renderNotificationList();
        });
        window.addEventListener('online', async () => {
            this.notificationsOffline = false;
            const dropdown = document.getElementById('notificationDropdown');
            if (dropdown && dropdown.style.display === 'block') await this.loadNotifications();
        });
        this.setupSettingsControls();
    }

    // ============ Section navigation (hash routing) ============
    // switchSection is the ONLY code path that writes location.hash, so every
    // section switch is a real history entry. The browser (and OS back / swipe
    // gestures) traverse those entries natively; hashchange simply re-renders
    // the target section. renderSection is a pure renderer — it never touches
    // the history API, so back/forward can never trigger a logout or a reload.
    switchSection(sectionId) {
        if (!SECTION_TITLES[sectionId]) return;
        if (this.getCurrentHash() === sectionId) { this.renderSection(sectionId); return; }
        location.hash = '#/' + sectionId;
    }

    getCurrentHash() {
        const match = (location.hash || '').match(/^#\/([a-z_]+)/);
        return match ? match[1] : null;
    }

    onHashChange() {
        this.renderSection(this.getCurrentHash() || this.defaultSection());
    }

    defaultSection() {
        return this.settings && this.settings.landing !== 'dashboard' ? this.settings.landing : 'dashboard';
    }

    initSectionRouting() {
        if (!this._hashBound) {
            this._hashBound = true;
            window.addEventListener('hashchange', () => this.onHashChange());
        }
        const current = this.getCurrentHash();
        if (current && SECTION_TITLES[current]) {
            this.renderSection(current);
        } else {
            const landing = this.defaultSection();
            history.replaceState(null, '', '#/' + landing);
            this.renderSection(landing);
        }
    }

    renderSection(sectionId) {
        if (!SECTION_TITLES[sectionId]) sectionId = 'dashboard';
        document.querySelectorAll('.sidebar-nav li').forEach(item => {
            const isActive = item.dataset.section === sectionId;
            item.classList.toggle('active', isActive);
            // Phase 4 converts the items to <a href="#/...">; until then keep
            // the legacy aria-current on the <li>.
            const link = item.querySelector('a');
            if (link) {
                if (isActive) link.setAttribute('aria-current', 'page');
                else link.removeAttribute('aria-current');
            } else if (isActive) {
                item.setAttribute('aria-current', 'page');
            } else {
                item.removeAttribute('aria-current');
            }
        });
        document.querySelectorAll('.content-section').forEach(section => {
            section.classList.toggle('active', section.id === sectionId);
        });

        document.getElementById('pageTitle').textContent = SECTION_TITLES[sectionId] || 'Dashboard';
        document.title = (SECTION_TITLES[sectionId] || 'Dashboard') + ' — E-Ticketing';
        this.currentSection = sectionId;

        if (sectionId === 'dashboard') this.renderPersonalDashboard();
        if (sectionId === 'tickets') this.filterTickets();
        if (sectionId === 'knowledge') this.loadKnowledgeArticles();
        if (sectionId === 'profile') this.loadProfile();
    }

    // ============ Session expired dialog ============
    // Registered with AuthAPI so an expired/revoked token surfaces
    // "Session expired" here instead of forcing a logout+redirect. Back/forward
    // and section switches never log anyone out; only an explicit logout
    // control or this acknowledged dialog ends the session.
    initSessionExpiredDialog() {
        AuthAPI.setOnSessionExpired(() => this._showSessionExpiredDialog());
    }

    _showSessionExpiredDialog() {
        const previous = document.activeElement;
        if (this._sessionExpiredDialog) {
            this._sessionExpiredDialog.style.display = 'block';
            this._focusSessionExpiredDialog(previous);
            return;
        }
        const dialog = document.createElement('div');
        dialog.className = 'modal';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'sessionExpiredTitle');
        dialog.setAttribute('aria-describedby', 'sessionExpiredMessage');

        const content = document.createElement('div');
        content.className = 'modal-content';
        content.style.maxWidth = '420px';

        const title = document.createElement('h3');
        title.id = 'sessionExpiredTitle';
        title.textContent = 'Session expired';

        const message = document.createElement('p');
        message.id = 'sessionExpiredMessage';
        message.textContent = 'Your session has expired — please log in again to continue.';

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const goLogin = document.createElement('button');
        goLogin.id = 'sessionExpiredGoLogin';
        goLogin.className = 'btn btn-primary';
        goLogin.textContent = 'Go to Login';
        goLogin.addEventListener('click', () => AuthAPI.logout());

        const stay = document.createElement('button');
        stay.id = 'sessionExpiredStay';
        stay.className = 'btn btn-secondary';
        stay.textContent = 'Stay here';
        stay.addEventListener('click', () => this._closeSessionExpiredDialog(previous));

        actions.appendChild(goLogin);
        actions.appendChild(stay);
        content.appendChild(title);
        content.appendChild(message);
        content.appendChild(actions);
        dialog.appendChild(content);
        document.body.appendChild(dialog);
        this._sessionExpiredDialog = dialog;

        dialog.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this._closeSessionExpiredDialog(previous);
                return;
            }
            if (e.key !== 'Tab') return;
            const focusables = dialog.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])');
            if (focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        });
        this._focusSessionExpiredDialog(previous);
    }

    _focusSessionExpiredDialog(previous) {
        this._sessionExpiredPreviousFocus = previous;
        const goLogin = document.getElementById('sessionExpiredGoLogin');
        if (goLogin && typeof goLogin.focus === 'function') goLogin.focus();
    }

    _closeSessionExpiredDialog(previous) {
        if (!this._sessionExpiredDialog) return;
        this._sessionExpiredDialog.style.display = 'none';
        if (previous && typeof previous.focus === 'function') previous.focus();
    }

    // ============ Personal dashboard: My Active Tickets / Recent Updates ============
    renderPersonalDashboard() {
        if (!this.currentUser) return;
        const mine = this.tickets.filter(t => t.created_by === this.currentUser.username);

        const active = mine.filter(t => t.status !== 'resolved').slice(0, 5);
        this.renderTicketRows('myActiveTickets', active, 'No active tickets right now — nice and clear!');

        const recent = [...mine]
            .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
            .slice(0, 5);
        this.renderTicketRows('recentUpdates', recent, 'No recent activity on your tickets yet.');

        const summary = document.getElementById('myTicketSummary');
        if (summary) {
            const open = mine.filter(t => t.status === 'open').length;
            const inProgress = mine.filter(t => t.status === 'in_progress').length;
            const resolved = mine.filter(t => t.status === 'resolved').length;
            summary.innerHTML = `
                <strong>${mine.length}</strong> total requests &middot;
                <strong>${open}</strong> open &middot;
                <strong>${inProgress}</strong> in progress &middot;
                <strong>${resolved}</strong> resolved
            `;
        }
    }

    renderTicketRows(containerId, tickets, emptyMessage) {
        const container = document.getElementById(containerId);

        if (tickets.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    ${Icons.render('inbox')}
                    <p>${emptyMessage}</p>
                    <a onclick="app.switchSection('create')">Report an issue &rarr;</a>
                </div>
            `;
            return;
        }

        container.innerHTML = tickets.map(t => `
            <div class="ticket-row">
                <div class="ticket-row-info">
                    <strong>${t.title}</strong>
                    <span>${t.ticket_number} &middot; updated ${new Date(t.updated_at).toLocaleDateString()}</span>
                </div>
                <span class="status-badge ${t.status}">${this.capitalize(t.status.replace('_', ' '))}</span>
            </div>
        `).join('');
    }

    async loadTickets() {
        document.getElementById('ticketTableBody').innerHTML = `
            <tr><td colspan="9" style="text-align:center;padding:30px;color:#999;">
                ${Icons.render('spinner', { state: 'loading' })} Loading tickets...
            </td></tr>
        `;
        try {
            // The SW annotates cache-served responses with X-ICT-Cache: hit so we
            // only stamp "last synced" when the data actually came from the server.
            const meta = await TicketAPI.getTicketsWithMeta();
            this.tickets = meta.tickets;
            if (meta.ok && !meta.fromCache) this.markSynced();
            this.filterTickets();
        } catch (error) {
            console.error('Error loading tickets:', error);
        }
    }

    // ============ Filtering, sorting, pagination ============
    filterTickets() {
        this.currentPage = 1;
        this.applyFiltersAndSort();
    }

    applyFiltersAndSort() {
        const statusFilter = document.getElementById('statusFilter').value;
        const priorityFilter = document.getElementById('priorityFilter').value;
        const searchQuery = document.getElementById('searchTicket').value.toLowerCase();

        let filtered = this.tickets;
        if (statusFilter !== 'all') filtered = filtered.filter(t => t.status === statusFilter);
        if (priorityFilter !== 'all') filtered = filtered.filter(t => t.priority === priorityFilter);
        if (searchQuery) {
            filtered = filtered.filter(t =>
                t.title.toLowerCase().includes(searchQuery) ||
                t.ticket_number.toLowerCase().includes(searchQuery) ||
                t.description.toLowerCase().includes(searchQuery)
            );
        }

        // Optional preference: start the list filtered to tickets created by me.
        if (this.settings && this.settings.myTicketsOnly && this.currentUser) {
            const me = this.currentUser.username;
            filtered = filtered.filter(t => t.created_by === me);
        }

        this.filteredTickets = this.sortTickets(filtered);
        this.renderCurrentPage();
        this.updateSortIndicators();
    }

    sortTickets(tickets) {
        const field = this.sortField;
        const dir = this.sortDirection === 'asc' ? 1 : -1;
        return [...tickets].sort((a, b) => {
            let valA = a[field];
            let valB = b[field];
            if (field === 'created_at' || field === 'updated_at') {
                valA = new Date(valA);
                valB = new Date(valB);
            } else if (typeof valA === 'string') {
                valA = valA.toLowerCase();
                valB = (valB || '').toLowerCase();
            }
            valA = valA ?? '';
            valB = valB ?? '';
            if (valA < valB) return -1 * dir;
            if (valA > valB) return 1 * dir;
            return 0;
        });
    }

    handleSort(field) {
        if (this.sortField === field) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortField = field;
            this.sortDirection = 'asc';
        }
        this.currentPage = 1;
        this.applyFiltersAndSort();
    }

    updateSortIndicators() {
        document.querySelectorAll('#tickets th[data-sort]').forEach(th => {
            th.classList.remove('sorted-asc', 'sorted-desc');
            if (th.dataset.sort === this.sortField) {
                th.classList.add(this.sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
            }
        });
    }

    renderCurrentPage() {
        const start = (this.currentPage - 1) * this.pageSize;
        const pageItems = this.filteredTickets.slice(start, start + this.pageSize);
        this.renderTickets(pageItems);
        this.renderPagination();
    }

    renderPagination() {
        const container = document.getElementById('paginationControls');
        const totalPages = Math.max(1, Math.ceil(this.filteredTickets.length / this.pageSize));
        if (this.currentPage > totalPages) this.currentPage = totalPages;

        if (this.filteredTickets.length === 0) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = `
            <button class="btn-secondary btn-sm" id="prevPageBtn" ${this.currentPage === 1 ? 'disabled' : ''}>
                ${Icons.render('chevron-left')} Prev
            </button>
            <span>Page ${this.currentPage} of ${totalPages} (${this.filteredTickets.length} tickets)</span>
            <button class="btn-secondary btn-sm" id="nextPageBtn" ${this.currentPage === totalPages ? 'disabled' : ''}>
                Next ${Icons.render('chevron-right')}
            </button>
        `;

        document.getElementById('prevPageBtn').addEventListener('click', () => {
            if (this.currentPage > 1) { this.currentPage--; this.renderCurrentPage(); }
        });
        document.getElementById('nextPageBtn').addEventListener('click', () => {
            if (this.currentPage < totalPages) { this.currentPage++; this.renderCurrentPage(); }
        });
    }

    // ============ Rendering ============
    renderTickets(tickets) {
        const tbody = document.getElementById('ticketTableBody');

        if (tickets.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="9">
                        <div class="empty-state">
                            ${Icons.render('folder-open')}
                            <p>No tickets found</p>
                            <a onclick="app.switchSection('create')">Report your first issue &rarr;</a>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = tickets.map(ticket => `
            <tr>
                <td><strong>${ticket.ticket_number}</strong></td>
                <td>${ticket.title}</td>
                <td>${this.capitalize(ticket.category)}</td>
                <td><span class="priority-badge ${ticket.priority}">${this.capitalize(ticket.priority)}</span></td>
                <td><span class="status-badge ${ticket.status}">${this.capitalize(ticket.status.replace('_', ' '))}</span></td>
                <td>${this.slaBadge(ticket)}</td>
                <td>${ticket.assigned_to || 'Unassigned'}</td>
                <td>${new Date(ticket.created_at).toLocaleDateString()}</td>
                <td>
                    <div class="action-buttons">
                        <button class="btn-secondary btn-sm" aria-label="View ticket" onclick="app.openTicketDetail(${ticket.id})">
                            ${Icons.render('eye')}
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');
    }

openTicketDetail(id) {
    const ticket = this.tickets.find(t => t.id === id);
    if (!ticket) return;
    this.activeTicketId = id;

    const body = document.getElementById('ticketDetailBody');
    body.innerHTML = `
        <h2 style="margin-bottom:5px;">${ticket.title}</h2>
        <p style="color:#999;margin-bottom:20px;">${ticket.ticket_number}</p>

        <div style="display:flex;gap:10px;margin-bottom:20px;">
            <span class="status-badge ${ticket.status}">${this.capitalize(ticket.status.replace('_', ' '))}</span>
            <span class="priority-badge ${ticket.priority}">${this.capitalize(ticket.priority)} priority</span>
        </div>

        <div style="margin-bottom:20px;">
            <strong>Service level:</strong>
            <div class="sla-due-wrap" style="margin-top:6px;">
                ${this.slaDueHtml(ticket)}
            </div>
        </div>

        <p style="margin-bottom:15px;"><strong>Category:</strong> ${this.capitalize(ticket.category)}</p>
        <p style="margin-bottom:15px;"><strong>Assigned To:</strong> ${ticket.assigned_to || 'Unassigned'}</p>
        <p style="margin-bottom:20px;"><strong>Description:</strong><br>${ticket.description}</p>

        ${ticket.resolution ? `<p style="margin-bottom:20px;"><strong>Resolution:</strong><br>${ticket.resolution}</p>` : ''}

        <div style="border-top:1px solid #f0f0f0;padding-top:15px;font-size:0.85rem;color:#999;margin-bottom:20px;">
            <p>Created: ${new Date(ticket.created_at).toLocaleString()}</p>
            <p>Last updated: ${new Date(ticket.updated_at).toLocaleString()}</p>
        </div>

        <div style="border-top:1px solid #f0f0f0;padding-top:15px;margin-bottom:20px;">
            <h3 style="margin-bottom:12px;">Attachments</h3>
            <div id="ticketAttachmentList"><p style="color:#999;">Loading...</p></div>
            <form id="ticketAttachmentForm" style="margin-top:12px;display:flex;gap:10px;align-items:center;">
                <input type="file" id="ticketAttachmentInput" style="flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:0.85rem;">
                <button type="submit" class="btn-primary btn-sm">${Icons.render('upload')} Upload</button>
            </form>
        </div>

        <div style="border-top:1px solid #f0f0f0;padding-top:15px;">
            <h3 style="margin-bottom:12px;">Conversation</h3>
            <div id="ticketCommentList"><p style="color:#999;">Loading...</p></div>
            <form id="commentForm" style="margin-top:15px;display:flex;gap:10px;">
                <input type="text" id="commentInput" placeholder="Add a reply..." style="flex:1;padding:10px;border:1px solid #ddd;border-radius:6px;" required>
                <button type="submit" class="btn-primary btn-sm">Send</button>
            </form>
        </div>
    `;

    document.getElementById('ticketDetailModal').style.display = 'block';
    document.getElementById('commentForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleCommentSubmit();
    });
    document.getElementById('ticketAttachmentForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleTicketAttachmentUpload();
    });
    this.loadTicketComments(id);
    this.loadTicketAttachments(id);
}

    slaBadge(ticket) {
        const breached = ticket.sla_resolution_breached;
        const due = ticket.sla_resolution_due;
        if (!due) return '<span class="sla-badge none">—</span>';

        const ms = new Date(due).getTime() - Date.now();
        const hours = Math.floor(ms / 3600000);
        const mins = Math.floor((ms % 3600000) / 60000);
        const when = ms > 0 ? `in ${hours}h ${mins}m` : `${Math.abs(hours)}h ${Math.abs(mins)}m ago`;

        if (breached) return `<span class="sla-badge breached">Breached · ${when}</span>`;
        if (ms < 3600000) return `<span class="sla-badge due_soon">${when}</span>`;
        return `<span class="sla-badge ok">${when}</span>`;
    }

    slaDueHtml(ticket) {
        const active = ticket.status === 'open' || ticket.status === 'in_progress';
        const line = (label, due, breached) => {
            if (!due) return `<p>${label}: <em>not set</em></p>`;
            const when = new Date(due).toLocaleString();
            const cls = active && breached ? 'breached' : '';
            const flag = active && breached ? ' (breached)' : '';
            return `<p class="${cls}">${label}: ${when}${flag}</p>`;
        };
        const resp = line('Response', ticket.sla_response_due, active && ticket.sla_response_breached);
        const resol = line('Resolution', ticket.sla_resolution_due, active && ticket.sla_resolution_breached);
        return `${resp}${resol}`;
    }

    async loadTicketAttachments(ticketId) {
        const container = document.getElementById('ticketAttachmentList');
        container.innerHTML = '<p style="color:#999;">Loading...</p>';

        let atts;
        try {
            atts = await TicketAPI.getAttachments(ticketId);
        } catch (error) {
            container.innerHTML = '<p style="color:var(--danger-dark, #b91c1c);font-size:0.9rem;">Could not load attachments — check your connection.</p>';
            console.error(error);
            return;
        }
        this.activeTicketAttachments = atts;
        if (atts.length === 0) {
            container.innerHTML = '<p style="color:#999;font-size:0.9rem;">No files attached yet.</p>';
            return;
        }
        container.innerHTML = atts.map(a => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f5f5f5;">
                ${Icons.render('paperclip', { style: 'color:#999;' })}
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${a.original_filename}</span>
                <span style="font-size:0.75rem;color:#999;white-space:nowrap;">${this.formatFileSize(a.file_size)}</span>
                <button class="btn-secondary btn-sm" aria-label="Download attachment" onclick="app.downloadTicketAttachment(${a.id})">
                    ${Icons.render('download')}
                </button>
                <button class="btn-danger btn-sm" aria-label="Delete attachment" onclick="app.deleteTicketAttachment(${a.id})">
                    ${Icons.render('trash')}
                </button>
            </div>
        `).join('');
    }

    formatFileSize(bytes) {
        if (!bytes && bytes !== 0) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(2) + ' MB';
    }

    async handleTicketAttachmentUpload() {
        const input = document.getElementById('ticketAttachmentInput');
        const file = input.files && input.files[0];
        if (!file || !this.activeTicketId) return;

        try {
            await TicketAPI.uploadAttachment(this.activeTicketId, file);
            input.value = '';
            this.showToast('File uploaded.');
            await this.loadTicketAttachments(this.activeTicketId);
        } catch (error) {
            this.showToast(error.message || 'Upload failed.', true);
            console.error(error);
        }
    }

    async downloadTicketAttachment(attachmentId) {
        const list = this.activeTicketAttachments || [];
        let att = list.find(a => a.id === attachmentId);
        if (!att) {
            try {
                const reloaded = await TicketAPI.getAttachments(this.activeTicketId);
                att = reloaded.find(a => a.id === attachmentId);
            } catch (error) {
                this.showToast('Could not load attachments — please try again.', true);
                console.error(error);
                return;
            }
        }
        if (!att) {
            this.showToast('This file is no longer available.', true);
            return;
        }
        await TicketAPI.downloadAttachment(att, (msg) => this.showToast(msg, true));
    }

    async deleteTicketAttachment(attachmentId) {
        if (!confirm('Delete this attachment?')) return;
        try {
            await TicketAPI.deleteAttachment(attachmentId);
            this.showToast('Attachment deleted.');
            await this.loadTicketAttachments(this.activeTicketId);
        } catch (error) {
            this.showToast('Failed to delete attachment.', true);
            console.error(error);
        }
    }   

    async loadTicketComments(ticketId) {
    const container = document.getElementById('ticketCommentList');
    const comments = await TicketAPI.getTicketComments(ticketId);

    if (comments.length === 0) {
        container.innerHTML = '<p style="color:#999;font-size:0.9rem;">No replies yet. Start the conversation below.</p>';
        return;
    }

    container.innerHTML = comments.map(c => `
        <div style="padding:10px 0;border-bottom:1px solid #f5f5f5;">
            <div style="display:flex;justify-content:space-between;">
                <strong style="font-size:0.9rem;">${c.author_username}</strong>
                <span style="font-size:0.75rem;color:#999;">${new Date(c.created_at).toLocaleString()}</span>
            </div>
            <p style="margin-top:4px;font-size:0.9rem;">${c.message}</p>
        </div>
    `).join('');
}

    async handleCommentSubmit() {
        const input = document.getElementById('commentInput');
        const message = input.value.trim();
        if (!message || !this.activeTicketId) return;

        try {
            await TicketAPI.createTicketComment(this.activeTicketId, message);
            input.value = '';
            await this.loadTicketComments(this.activeTicketId);
        } catch (error) {
            this.showToast('Failed to post reply.', true);
            console.error(error);
        }
    }
    async handleTicketSubmit(e) {
        if (!this.validateTicketForm()) {
            this.showToast('Please fill in the required fields highlighted below.', true);
            return;
        }

        const form = e.target;
        const formData = {
            title: document.getElementById('title').value,
            description: document.getElementById('description').value,
            category: document.getElementById('category').value,
            priority: document.getElementById('priority').value,
            created_by: this.currentUser ? this.currentUser.username : 'anonymous'
        };

        // createTicketOffline attaches a client_uuid and classifies the outcome:
        // ok / network failure (retryable) / HTTP error (server rejection).
        const result = await TicketAPI.createTicketOffline(formData);

        if (result.ok) {
            this.showToast('Ticket created successfully!');
            form.reset();
            await this.loadTickets();
            this.renderPersonalDashboard();
            this.switchSection('tickets');
            // IDLE — costs money when enabled (paid push provider).
            this.maybePushNotify({ type: 'ticket_created', data: result.data });
        } else if (result.network) {
            // Offline or server unreachable — the exact payload (with its
            // client_uuid) is kept locally and submitted by the sync loop.
            await this.enqueueTicket(formData);
            form.reset();
            this.showToast('Saved offline — will submit when online.');
            await this.updatePendingBadge();
        } else {
            if (result.status === 401) {
                AuthAPI.onSessionExpired();
            } else {
                this.showToast(result.error.message || 'Failed to create ticket. Please try again.', true);
            }
        }
    }

    // ============ Focus Mode ============
    applyFocusMode() {
        const saved = localStorage.getItem('focusMode');
        if (saved === 'on') {
            document.body.classList.add('focus-mode');
            this.updateFocusModeButtonLabel(true);
        }
    }

    toggleFocusMode() {
        const isOn = document.body.classList.toggle('focus-mode');
        localStorage.setItem('focusMode', isOn ? 'on' : 'off');
        this.updateFocusModeButtonLabel(isOn);
    }

    updateFocusModeButtonLabel(isOn) {
        const btn = document.getElementById('focusModeToggleBtn');
        btn.innerHTML = isOn
            ? Icons.render('eye-slash') + ' Exit Focus Mode'
            : Icons.render('target') + ' Focus Mode';
    }

    // ============ Micro-interactions ============
    animateCountUp(elementId, target) {
        const el = document.getElementById(elementId);
        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (prefersReducedMotion) {
            el.textContent = target;
            return;
        }
        const duration = 600;
        const startTime = performance.now();
        const step = (now) => {
            const progress = Math.min((now - startTime) / duration, 1);
            el.textContent = Math.round(target * progress);
            if (progress < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    showResolvedCelebration() {
        const el = document.createElement('div');
        el.className = 'resolved-flash';
        el.style.cssText = 'position:fixed;top:50%;left:50%;font-size:4rem;color:var(--success-color);z-index:4000;pointer-events:none;';
        el.innerHTML = Icons.render('check-circle');
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 700);
    }

    // ============ Form validation ============
    validateTicketForm() {
        let valid = true;
        const fields = [
            { id: 'title', groupId: 'titleGroup' },
            { id: 'description', groupId: 'descriptionGroup' },
            { id: 'category', groupId: 'categoryGroup' }
        ];
        fields.forEach(f => {
            const input = document.getElementById(f.id);
            const group = document.getElementById(f.groupId);
            if (!input.value.trim()) {
                group.classList.add('invalid');
                valid = false;
            } else {
                group.classList.remove('invalid');
            }
        });
        return valid;
    }

    // ============ Knowledge Base ============
    async loadKnowledgeArticles() {
        const query = document.getElementById('kbSearch').value;
        const category = document.getElementById('kbCategoryFilter').value;
        const container = document.getElementById('kbArticleList');
        container.innerHTML = `<p style="color:#999;">${Icons.render('spinner', { state: 'loading' })} Searching...</p>`;

        const articles = await TicketAPI.getKnowledgeArticles(query, category);
        this.renderKnowledgeArticles(articles);
    }

    renderKnowledgeArticles(articles) {
        const container = document.getElementById('kbArticleList');

        if (articles.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    ${Icons.render('search')}
                    <p>No articles match your search.</p>
                    <a onclick="app.switchSection('create')">Create a ticket instead &rarr;</a>
                </div>
            `;
            return;
        }

        container.innerHTML = articles.map(a => `
            <div class="chart-card" style="cursor:pointer;" onclick="app.toggleArticle(${a.id})">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <h3 style="margin:0;">${a.title}</h3>
                    <span class="status-badge open">${this.capitalize(a.category)}</span>
                </div>
                <div id="kb-article-${a.id}" style="display:none;margin-top:15px;color:#555;line-height:1.6;">
                    ${a.content}
                </div>
                <div style="margin-top:10px;font-size:0.75rem;color:#999;">
                    ${a.author_username ? `By ${a.author_username}` : ''}${a.updated_at ? ` &middot; Updated ${new Date(a.updated_at).toLocaleDateString()}` : ''}
                </div>
            </div>
        `).join('');
    }

    toggleArticle(id) {
        const el = document.getElementById(`kb-article-${id}`);
        if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }

    // ============ Notifications ============
    notificationCategoryVisible(n) {
        if (!n || !n.category) return true;
        if (typeof window.NotificationPrefs === 'undefined') return true;
        return window.NotificationPrefs.isCategoryEnabled(n.category);
    }

    visibleNotifications() {
        return this.notifications.filter(n => this.notificationCategoryVisible(n));
    }

    async loadNotifications() {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            const cached = this.loadNotificationsCache();
            if (cached) {
                this.notifications = cached.notifications || [];
                this.notificationUnread = cached.unread_count || 0;
                this.notificationsOffline = true;
            } else {
                this.notifications = [];
                this.notificationUnread = 0;
                this.notificationsOffline = true;
            }
        } else {
            const data = await TicketAPI.getNotifications();
            this.notifications = data.notifications || [];
            this.notificationUnread = data.unread_count || 0;
            this.notificationsOffline = false;
            this.saveNotificationsCache();
        }
        this.renderNotificationBadge(this.notificationUnread);
        this.updateNotificationUnreadUI();
        this.renderNotificationList();
    }

    saveNotificationsCache() {
        try {
            sessionStorage.setItem('ntf_cache', JSON.stringify({
                notifications: this.notifications,
                unread_count: this.notificationUnread,
                at: Date.now()
            }));
        } catch (e) { /* storage unavailable: offline rendering degrades gracefully */ }
    }

    loadNotificationsCache() {
        try {
            const raw = sessionStorage.getItem('ntf_cache');
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    renderNotificationBadge(count) {
        const badge = document.getElementById('notificationBadge');
        if (!badge) return;
        if (count > 0) {
            badge.textContent = count;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
        const bell = document.getElementById('notificationBell');
        if (bell) bell.setAttribute('aria-label', count > 0 ? `Notifications, ${count} unread` : 'Notifications');
        const live = document.getElementById('notificationA11yAnnounce');
        if (live) live.textContent = count > 0 ? `${count} unread notifications` : 'No unread notifications';
    }

    updateNotificationUnreadUI() {
        const pill = document.getElementById('notificationUnreadPill');
        if (pill) {
            if (this.notificationUnread > 0) {
                pill.textContent = `${this.notificationUnread} unread`;
                pill.hidden = false;
            } else {
                pill.hidden = true;
            }
        }
        const tabCount = document.getElementById('notificationUnreadTabCount');
        if (tabCount) {
            if (this.notificationUnread > 0) {
                tabCount.textContent = this.notificationUnread;
                tabCount.hidden = false;
            } else {
                tabCount.hidden = true;
            }
        }
    }

    toggleNotificationDropdown() {
        const dropdown = document.getElementById('notificationDropdown');
        if (!dropdown) return;
        const isOpen = dropdown.style.display === 'block';
        dropdown.style.display = isOpen ? 'none' : 'block';
        const bell = document.getElementById('notificationBell');
        if (bell) bell.setAttribute('aria-expanded', String(!isOpen));
        if (!isOpen) this.renderNotificationList();
    }

    closeNotificationDropdown() {
        const dropdown = document.getElementById('notificationDropdown');
        const bell = document.getElementById('notificationBell');
        if (dropdown) dropdown.style.display = 'none';
        if (bell) bell.setAttribute('aria-expanded', 'false');
    }

    setNotificationFilter(filter) {
        this.notificationFilter = filter;
        const tabs = document.querySelectorAll('.notification-tab');
        tabs.forEach(tab => {
            tab.setAttribute('aria-pressed', String(tab.dataset.filter === filter));
        });
        this.renderNotificationList();
    }

    renderNotificationList() {
        const container = document.getElementById('notificationList');
        if (!container) return;

        if (this.notificationsOffline && this.notifications.length === 0) {
            container.innerHTML = `
                <div class="empty-state" style="padding:20px;">
                    ${Icons.render('wifi')}
                    <p>Requires connection</p>
                    <p style="font-size:0.75rem;margin-top:5px;">Notifications can't load right now. Check your connection and retry.</p>
                    <button type="button" class="btn-secondary btn-sm" onclick="app.loadNotifications()" style="margin-top:12px;">Retry</button>
                </div>
            `;
            this.renderLastSynced();
            return;
        }

        const filtered = this.visibleNotifications().filter(n => this.notificationFilter === 'unread' ? !n.is_read : true);
        if (filtered.length === 0) {
            container.innerHTML = this.renderEmptyState();
            this.renderLastSynced();
            return;
        }
        container.innerHTML = this.renderNotificationGroups(filtered);
        this.renderLastSynced();
    }

    renderEmptyState() {
        if (this.notificationFilter === 'unread' && this.notifications.length > 0) {
            return `
                <div class="empty-state" style="padding:20px;">
                    ${Icons.render('check-circle')}
                    <p>You're all caught up.</p>
                </div>
            `;
        }
        return `
            <div class="empty-state" style="padding:20px;">
                ${Icons.render('bell-slash')}
                <p>No notifications yet.</p>
            </div>
        `;
    }

    renderNotificationGroups(list) {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const today = list.filter(n => new Date(n.created_at).getTime() >= startOfToday);
        const earlier = list.filter(n => new Date(n.created_at).getTime() < startOfToday);
        let html = '';
        if (today.length) html += `<div class="notification-group">Today</div>` + this.renderNotificationItems(today);
        if (earlier.length) html += `<div class="notification-group">Earlier</div>` + this.renderNotificationItems(earlier);
        return html;
    }

    renderNotificationItems(items) {
        return items.map(n => {
            const msg = escapeHtml(n.message);
            const tip = escapeHtml(n.link ? `${n.message} — view ticket` : n.message);
            return `
                <button type="button" class="notification-item ${n.is_read ? '' : 'unread'}" aria-label="${msg}" title="${tip}" onclick="app.onNotificationClick(${n.id})">
                    <span class="notification-type-icon" aria-hidden="true">${Icons.render(this.notificationIcon(n.type))}</span>
                    <span class="notification-item-text">
                        <span class="notification-item-msg">${msg}</span>
                        <span class="notification-item-time">${escapeHtml(this.friendlyTime(n.created_at))}</span>
                    </span>
                </button>
            `;
        }).join('');
    }

    notificationIcon(type) {
        switch (type) {
            case 'ticket_update': return 'ticket';
            case 'technician_reply': return 'user';
            case 'announcement': return 'bullhorn';
            case 'sla_breach': return 'exclamation-triangle';
            default: return 'bell';
        }
    }

    friendlyTime(iso) {
        const then = new Date(iso).getTime();
        if (!iso || isNaN(then)) return '';
        const diffMin = Math.floor((Date.now() - then) / 60000);
        if (diffMin < 1) return 'just now';
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffH = Math.floor(diffMin / 60);
        if (diffH < 24) return `${diffH}h ago`;
        const diffD = Math.floor(diffH / 24);
        if (diffD < 7) return `${diffD}d ago`;
        return new Date(iso).toLocaleDateString();
    }

    renderLastSynced() {
        const el = document.getElementById('notificationLastSynced');
        if (!el) return;
        const cache = this.loadNotificationsCache();
        if (this.notificationsOffline && cache && cache.at) {
            el.textContent = `Last synced ${new Date(cache.at).toLocaleString()}`;
            el.hidden = false;
        } else {
            el.hidden = true;
        }
    }

    async onNotificationClick(id) {
        const n = this.notifications.find(x => x.id === id);
        if (n && !n.is_read) {
            if (this.notificationsOffline) {
                this.showToast('Marking as read requires a connection.', true);
                return;
            }
            n.is_read = true;
            this.notificationUnread = Math.max(0, (this.notificationUnread || 0) - 1);
            try {
                await TicketAPI.markNotificationRead(id);
            } catch (e) { /* optimistic update only; refetch next sync */ }
            this.renderNotificationBadge(this.notificationUnread);
            this.updateNotificationUnreadUI();
            this.renderNotificationList();
        }
        if (n && n.link) {
            this.closeNotificationDropdown();
            this.openTicketDetail(parseInt(n.link, 10));
        }
    }

    async markNotificationRead(id) {
        await TicketAPI.markNotificationRead(id);
        await this.loadNotifications();
    }

    async markAllNotificationsRead() {
        if (this.notificationsOffline) {
            this.showToast('Marking notifications as read requires a connection.', true);
            return;
        }
        await TicketAPI.markAllNotificationsRead();
        await this.loadNotifications();
    }

    // ============ Theme ============
    applyTheme() {
        document.documentElement.setAttribute('data-theme', this.currentTheme());
        document.documentElement.classList.toggle('dark-theme', this.isDark());
        this.updateThemePicker();
    }

    applyNamedTheme(id) {
        if (!THEME_REGISTRY[id]) return;
        document.documentElement.setAttribute('data-theme', id);
        document.documentElement.classList.toggle('dark-theme', THEME_REGISTRY[id] === 'dark');
        localStorage.setItem('user_theme', id);
        this.updateThemePicker();
    }

    /* Show an uncommitted theme across the whole page. Restored by
       restoreTheme() on leave/blur/Escape, so nothing persists on preview. */
    previewTheme(id) {
        if (!THEME_REGISTRY[id]) return;
        document.documentElement.setAttribute('data-theme', id);
    }

    restoreTheme() {
        this.applyTheme();
    }

    currentTheme() {
        const saved = localStorage.getItem('user_theme') || 'light';
        if (THEME_REGISTRY[saved]) return saved;
        return saved === 'dark' ? 'abyss' : 'daylight'; /* legacy toggle */
    }

    isDark() {
        return THEME_REGISTRY[this.currentTheme()] === 'dark';
    }

    updateThemePicker() {
        const group = document.getElementById('themeControl');
        if (!group) return;
        const current = this.currentTheme();
        group.querySelectorAll('.theme-card').forEach(card => {
            const active = card.dataset.theme === current;
            card.setAttribute('aria-checked', active ? 'true' : 'false');
            card.tabIndex = active ? 0 : -1;
        });
    }

    initThemePicker() {
        const group = document.getElementById('themeControl');
        if (!group || group.dataset.pickerInit) return;
        group.dataset.pickerInit = '1';
        const cards = Array.prototype.slice.call(group.querySelectorAll('.theme-card'));
        if (cards.length === 0) return;
        const cardIndex = el => cards.indexOf(el);
        this.updateThemePicker();
        cards.forEach(card => {
            card.addEventListener('click', () => this.applyNamedTheme(card.dataset.theme));
            card.addEventListener('mouseenter', () => this.previewTheme(card.dataset.theme));
            card.addEventListener('focus', () => this.previewTheme(card.dataset.theme));
            card.addEventListener('mouseleave', () => this.restoreTheme());
            card.addEventListener('blur', () => this.restoreTheme());
            card.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.applyNamedTheme(card.dataset.theme);
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    this.restoreTheme();
                    return;
                }
                const i = cardIndex(card);
                let target = null;
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') target = cards[Math.min(cards.length - 1, i + 1)];
                else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') target = cards[Math.max(0, i - 1)];
                else if (e.key === 'Home') target = cards[0];
                else if (e.key === 'End') target = cards[cards.length - 1];
                if (target) {
                    e.preventDefault();
                    target.focus();
                }
            });
        });
    }

    // ============ User settings (offline-first device preferences) ============
    // Single 'settings' JSON key in localStorage. All eight preferences work
    // fully offline: class/state changes plus a client-side idle timer. Nothing
    // here depends on a fetch or on the server. Defaults match the current
    // out-of-the-box behaviour so the portal looks identical to today.
    SETTINGS_DEFAULTS() {
        return {
            density: 'comfortable',
            textSize: 'default',
            reduceMotion: false,
            landing: 'dashboard',
            myTicketsOnly: false,
            pageSize: 10,
            idleLogout: 0
        };
    }

    getSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (raw) return Object.assign({}, this.SETTINGS_DEFAULTS(), JSON.parse(raw) || {});
        } catch (e) { /* fall through */ }
        return this.SETTINGS_DEFAULTS();
    }

    saveSettings(patch) {
        try {
            const next = Object.assign({}, this.getSettings(), patch);
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
            return next;
        } catch (e) {
            this.showToast('Could not save settings.', true);
            return this.getSettings();
        }
    }

    // Apply the settings that map to <html> classes / this.pageSize, and sync
    // the Settings controls to the stored values. Called once at startup and
    // re-rendered on every change.
    applySettings() {
        this.settings = this.getSettings();
        this.pageSize = parseInt(this.settings.pageSize, 10) || 10;
        const el = document.documentElement;
        el.classList.toggle('density-compact', this.settings.density === 'compact');
        el.classList.toggle('font-small', this.settings.textSize === 'small');
        el.classList.toggle('font-large', this.settings.textSize === 'large');
        el.classList.toggle('reduced-motion', !!this.settings.reduceMotion);
        this.renderSettingsControls();
        this.setupIdleLogout();
    }

    renderSettingsControls() {
        const s = this.settings;

        const seg = (id, attr) => {
            const group = document.getElementById(id);
            if (!group) return;
            group.querySelectorAll('button[data-value]').forEach(btn => {
                const active = btn.dataset.value === String(s[attr]);
                btn.classList.toggle('selected', active);
                btn.setAttribute('aria-checked', active ? 'true' : 'false');
            });
        };
        seg('densityControl', 'density');
        seg('textSizeControl', 'textSize');
        seg('landingControl', 'landing');

        const reduce = document.getElementById('reduceMotionToggle');
        if (reduce) reduce.checked = !!s.reduceMotion;
        const myTickets = document.getElementById('myTicketsToggle');
        if (myTickets) myTickets.checked = !!s.myTicketsOnly;
        const pageSize = document.getElementById('pageSizeSelect');
        if (pageSize) pageSize.value = String(s.pageSize);
        const idle = document.getElementById('idleLogoutSelect');
        if (idle) idle.value = String(s.idleLogout);
    }

    setupSettingsControls() {
        const seg = (id, attr, apply) => {
            const group = document.getElementById(id);
            if (!group) return;
            group.querySelectorAll('button[data-value]').forEach(btn => {
                btn.addEventListener('click', () => {
                    this.settings = this.saveSettings({ [attr]: btn.dataset.value });
                    this.renderSettingsControls();
                    if (apply) apply();
                });
            });
        };

        seg('densityControl', 'density', () => {
            document.documentElement.classList.toggle('density-compact', this.settings.density === 'compact');
        });
        seg('textSizeControl', 'textSize', () => {
            const el = document.documentElement;
            el.classList.toggle('font-small', this.settings.textSize === 'small');
            el.classList.toggle('font-large', this.settings.textSize === 'large');
        });
        // Landing page takes effect on the next login; saving is enough here.
        seg('landingControl', 'landing', () => {});

        const reduce = document.getElementById('reduceMotionToggle');
        if (reduce) reduce.addEventListener('change', () => {
            this.settings = this.saveSettings({ reduceMotion: reduce.checked });
            document.documentElement.classList.toggle('reduced-motion', reduce.checked);
        });

        const myTickets = document.getElementById('myTicketsToggle');
        if (myTickets) myTickets.addEventListener('change', () => {
            this.settings = this.saveSettings({ myTicketsOnly: myTickets.checked });
            if (this.currentSection === 'tickets') this.applyFiltersAndSort();
        });

        const pageSize = document.getElementById('pageSizeSelect');
        if (pageSize) pageSize.addEventListener('change', () => {
            const n = parseInt(pageSize.value, 10) || 10;
            this.settings = this.saveSettings({ pageSize: n });
            this.pageSize = n;
            if (this.currentSection === 'tickets') this.renderCurrentPage();
        });

        const idle = document.getElementById('idleLogoutSelect');
        if (idle) idle.addEventListener('change', () => {
            this.settings = this.saveSettings({ idleLogout: parseInt(idle.value, 10) || 0 });
            this.setupIdleLogout();
        });

        const clearBtn = document.getElementById('clearLocalDataBtn');
        if (clearBtn) clearBtn.addEventListener('click', () => this.clearLocalData());
    }

    // Inactivity timer: after idleLogout minutes with no key/pointer/touch/
    // scroll activity the session is ended client-side. Never fires when the
    // preference is "Never" (0). Works offline — it is a purely local timer.
    setupIdleLogout() {
        if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
        const minutes = parseInt(this.settings && this.settings.idleLogout, 10) || 0;
        if (minutes <= 0) return;

        if (!this._idleListenersBound) {
            this._idleListenersBound = true;
            const reset = () => { this._idleLast = Date.now(); };
            ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(ev =>
                document.addEventListener(ev, reset, { passive: true })
            );
            // Tab re-appearing after a long background pause: count that elapsed
            // time honestly rather than restarting the timer.
            document.addEventListener('visibilitychange', () => {
                if (document.hidden || !this._idleTimer) return;
                const mins = parseInt(this.settings && this.settings.idleLogout, 10) || 0;
                if (mins > 0 && Date.now() - this._idleLast >= mins * 60000) {
                    this.logoutForIdle();
                } else {
                    this._idleLast = Date.now();
                }
            });
        }

        this._idleLast = Date.now();
        this._idleTimer = setInterval(() => {
            const mins = parseInt(this.settings && this.settings.idleLogout, 10) || 0;
            if (mins > 0 && Date.now() - this._idleLast >= mins * 60000) {
                this.logoutForIdle();
            }
        }, 30000);
    }

    logoutForIdle() {
        if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
        AuthAPI.logout();
    }

    // Danger-zone helper: removes device-local portal data (settings, profile,
    // theme, focus mode, sidebar layout, offline queue) without touching the
    // server. The current session resets to defaults immediately.
    clearLocalData() {
        if (!confirm('Clear all locally stored portal data?\n\nThis removes your saved settings, profile picture, theme, focus mode, sidebar layout, and any offline submissions still waiting to sync. Your tickets on the server are not affected.')) return;

        try {
            ['settings', 'user_theme', 'focusMode', 'profile', 'sidebar:state', 'sidebarMode'].forEach(k => localStorage.removeItem(k));
            sessionStorage.removeItem('sidebarCollapsed');
        } catch (e) { /* non-fatal */ }

        // Drop the offline queue (IndexedDB). In-flight writes are discarded
        // by the browser when the database is deleted.
        OfflineDB._db = null;
        try { indexedDB.deleteDatabase('ict_offline'); } catch (e) { /* non-fatal */ }

        // Reset this session to the defaults the user just saw.
        const el = document.documentElement;
        el.classList.remove('density-compact', 'font-small', 'font-large', 'reduced-motion');
        document.body.classList.remove('focus-mode');
        this.updateFocusModeButtonLabel(false);
        this.applyTheme();
        this.settings = this.getSettings();
        this.pageSize = 10;
        this.renderSettingsControls();
        this.setupIdleLogout();
        this.renderIdentity();
        const badge = document.getElementById('pendingBadge');
        if (badge) badge.style.display = 'none';
        if (this.currentSection === 'tickets') this.applyFiltersAndSort();
        this.showToast('Local data cleared.');
    }

    // ============ Local profile (offline-first account settings) ============
    getLocalProfile() {
        try {
            const raw = localStorage.getItem('profile');
            if (raw) return JSON.parse(raw) || {};
        } catch (e) { /* fall through */ }
        return {};
    }

    saveLocalProfile(patch) {
        try {
            const profile = Object.assign({}, this.getLocalProfile(), patch);
            localStorage.setItem('profile', JSON.stringify(profile));
            return profile;
        } catch (e) {
            this.showToast('Could not save profile changes.', true);
            return this.getLocalProfile();
        }
    }

    getEffectiveProfile(api) {
        const user = api || AuthAPI.getCurrentUser() || {};
        const local = this.getLocalProfile();
        return {
            displayName: local.displayName || user.username || user.email || '',
            username: user.username || local.username || '',
            email: local.email || user.email || '',
            role: user.role || local.role || '',
            phone: local.phone || '',
            department: local.department || user.department || '',
            avatar: local.avatar || ''
        };
    }

    _esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ============ Sidebar identity (avatar monogram + name + role) ============
    renderIdentity() {
        const user = AuthAPI.getCurrentUser();
        const nameEl = document.getElementById('sidebarUserName');
        const roleEl = document.getElementById('sidebarUserRole');
        const avatarEl = document.getElementById('sidebarAvatar');
        if (!user) return;
        const eff = this.getEffectiveProfile();
        const name = eff.displayName || eff.username || 'User';
        if (nameEl) { nameEl.textContent = name; nameEl.title = name; }
        if (roleEl) {
            const roleLabel = eff.role
                ? eff.role.charAt(0).toUpperCase() + eff.role.slice(1)
                : 'User';
            roleEl.textContent = roleLabel;
            roleEl.title = roleLabel;
        }
        if (avatarEl) {
            if (eff.avatar) {
                avatarEl.innerHTML = '<img src="' + eff.avatar + '" alt="" aria-hidden="true">';
            } else {
                avatarEl.textContent = name.charAt(0).toUpperCase();
            }
        }
    }

    // ============ Profile ============
    async loadPreferences() {
        const prefs = await TicketAPI.getNotificationPreferences();
        const email = document.getElementById('prefEmail');
        const inapp = document.getElementById('prefInApp');
        if (email) email.checked = !!prefs.email_enabled;
        if (inapp) inapp.checked = !!prefs.in_app_enabled;
    }

    loadNotificationPrefs() {
        const container = document.getElementById('notificationPrefs');
        if (!container) return;
        if (typeof window.NotificationPrefs === 'undefined') {
            container.innerHTML = '<div class="pref-offline"><strong>Not available</strong><p>Notification preferences could not be loaded right now.</p></div>';
            return;
        }
        window.NotificationPrefs.render(container);
    }

    async savePrefs() {
        const prefs = {
            email_enabled: document.getElementById('prefEmail').checked,
            in_app_enabled: document.getElementById('prefInApp').checked
        };
        try {
            await TicketAPI.updateNotificationPreferences(prefs);
            const msg = document.getElementById('prefSaveMsg');
            if (msg) { msg.style.display = 'block'; setTimeout(() => { msg.style.display = 'none'; }, 2500); }
        } catch (error) {
            this.showToast(error.message, true);
        }
    }

    async load2FA() {
        const state = document.getElementById('twofaState');
        if (!state) return;
        let status;
        try {
            status = await TicketAPI.get2FAStatus();
        } catch (error) {
            state.innerHTML = '<p style="color:#999;">Could not load 2FA status.</p>';
            return;
        }
        if (status.enabled) {
            state.innerHTML = `
                <p style="margin-bottom:12px;"><span class="status-badge resolved" style="display:inline-block;">Enabled</span></p>
                <p style="font-size:0.85rem;color:#999;margin-bottom:12px;">Your account is protected by an authenticator app.</p>
                <input type="text" id="twofaDisableCode" inputmode="numeric" maxlength="6" placeholder="Enter code to disable"
                    style="padding:8px 10px;border:1px solid #eee;border-radius:6px;width:100%;margin-bottom:8px;">
                <button class="btn-secondary btn-sm" id="twofaDisableBtn">Disable Two-Factor Auth</button>
            `;
            document.getElementById('twofaDisableBtn').addEventListener('click', async () => {
                try {
                    await TicketAPI.disable2FA(document.getElementById('twofaDisableCode').value.trim());
                    this.showToast('Two-factor authentication disabled.');
                    this.load2FA();
                } catch (error) {
                    this.showToast(error.message, true);
                }
            });
        } else {
            state.innerHTML = `
                <p style="font-size:0.85rem;color:#999;margin-bottom:12px;">Two-factor authentication is currently off.</p>
                <button class="btn-primary btn-sm" id="twofaEnableBtn">Enable Two-Factor Auth</button>
                <div id="twofaSetup" style="display:none;margin-top:14px;"></div>
            `;
            document.getElementById('twofaEnableBtn').addEventListener('click', async () => {
                try {
                    const setup = await TicketAPI.setup2FA();
                    const host = document.getElementById('twofaSetup');
                    host.style.display = 'block';
                    host.innerHTML = `
                        <p style="font-size:0.85rem;color:#999;margin-bottom:10px;">
                            1. Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password&hellip;)
                            or enter the secret manually: <code>${setup.secret}</code>
                        </p>
                        <div id="twofaQr" style="margin-bottom:12px;"></div>
                        <p style="font-size:0.85rem;color:#999;margin-bottom:8px;">2. Enter the 6-digit code to verify:</p>
                        <input type="text" id="twofaSetupCode" inputmode="numeric" maxlength="6" placeholder="••••••"
                            style="padding:8px 10px;border:1px solid #eee;border-radius:6px;width:100%;margin-bottom:8px;letter-spacing:0.3em;">
                        <button class="btn-primary btn-sm" id="twofaVerifyBtn">Activate Two-Factor Auth</button>
                    `;
                    if (window.QRCode) {
                        new QRCode(document.getElementById('twofaQr'), { text: setup.otpauth_uri, width: 160, height: 160 });
                    } else {
                        document.getElementById('twofaQr').innerHTML =
                            '<a href="' + setup.otpauth_uri + '" class="btn-secondary btn-sm">Open in authenticator app</a>';
                    }
                    document.getElementById('twofaVerifyBtn').addEventListener('click', async () => {
                        try {
                            await TicketAPI.verify2FASetup(document.getElementById('twofaSetupCode').value.trim());
                            this.showToast('Two-factor authentication enabled!');
                            this.load2FA();
                        } catch (error) {
                            this.showToast(error.message, true);
                        }
                    });
                } catch (error) {
                    this.showToast(error.message, true);
                }
            });
        }
    }

    async loadProfile() {
        const container = document.getElementById('accountInfo');
        container.innerHTML = '<p style="color:#999;">Loading...</p>';

        const profile = await TicketAPI.getMyProfile();
        if (!profile) {
            container.innerHTML = '<p style="color:#999;">Could not load profile.</p>';
            return;
        }

        const eff = this.getEffectiveProfile(profile);
        const initial = (eff.displayName || eff.username || 'U').charAt(0).toUpperCase();

        container.innerHTML = `
            <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start;">
                <div style="text-align:center;flex-shrink:0;width:110px;">
                    <div id="profileAvatarPreview" style="width:72px;height:72px;margin:0 auto 10px;border-radius:50%;background:#eef2ff;border:1px solid #eee;color:#2563eb;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.6rem;overflow:hidden;">${initial}</div>
                    <button type="button" class="btn-secondary btn-sm" id="uploadAvatarBtn" style="width:100%;margin-bottom:6px;">${Icons.render('upload')} Upload</button>
                    <button type="button" class="btn-secondary btn-sm" id="removeAvatarBtn" style="width:100%;display:${eff.avatar ? 'block' : 'none'};">Remove</button>
                    <input type="file" id="avatarFileInput" accept="image/*" style="display:none;" aria-label="Choose a profile picture">
                </div>
                <div style="flex:1;min-width:280px;">
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                        <div class="form-group">
                            <label for="infoDisplayName">Display Name</label>
                            <input type="text" id="infoDisplayName" value="${this._esc(eff.displayName || '')}" placeholder="${this._esc(profile.username || '')}">
                        </div>
                        <div class="form-group">
                            <label for="infoPhone">Phone</label>
                            <input type="tel" id="infoPhone" value="${this._esc(eff.phone || '')}" placeholder="e.g. +254 7XX XXX XXX">
                        </div>
                        <div class="form-group">
                            <label for="infoDepartment">Department</label>
                            <input type="text" id="infoDepartment" value="${this._esc(eff.department || '')}" placeholder="Optional">
                        </div>
                        <div class="form-group">
                            <label for="infoUsername">Username</label>
                            <input type="text" id="infoUsername" value="${this._esc(eff.username || '')}" maxlength="50" minlength="2" title="Your sign-in name, used to log in">
                            <div class="form-hint">Your sign-in name. Changing it updates your login and ticket history.</div>
                        </div>
                        <div class="form-group">
                            <label for="infoEmail">Email</label>
                            <input type="email" id="infoEmail" value="${this._esc(eff.email || '')}">
                        </div>
                        <div class="form-group">
                            <label for="infoRole">Role</label>
                            <input type="text" id="infoRole" value="${this._esc(eff.role || 'User')}" readonly title="Assigned by your administrator">
                            <div class="form-hint">Assigned by your administrator</div>
                        </div>
                    </div>
                    <div id="usernameChangeGuard" style="display:none;margin-top:2px;">
                        <div class="form-group password-field" data-password-field data-mode="enter">
                            <label for="profileCurrentPassword">Current Password</label>
                            <input type="password" id="profileCurrentPassword" autocomplete="current-password">
                        </div>
                        <div class="form-hint" style="margin-top:-8px;">Required when you change your username.</div>
                    </div>
                    <div style="margin-top:14px;text-align:right;">
                        <button type="button" class="btn-primary btn-sm" id="saveProfileBtn">Save Changes</button>
                        <span id="profileSaveMsg" style="display:none;font-size:0.85rem;color:#22c55e;margin-left:10px;">Profile saved.</span>
                    </div>
                </div>
            </div>
        `;

        const preview = document.getElementById('profileAvatarPreview');
        if (eff.avatar && preview) {
            preview.innerHTML = '<img src="' + eff.avatar + '" alt="" style="width:100%;height:100%;object-fit:cover;">';
        }

        if (window.PasswordField) PasswordField.refresh(container);

        document.getElementById('uploadAvatarBtn').addEventListener('click', () => {
            document.getElementById('avatarFileInput').click();
        });
        document.getElementById('avatarFileInput').addEventListener('change', (e) => {
            this.handleAvatarFile(e.target.files && e.target.files[0]);
            e.target.value = '';
        });
        document.getElementById('removeAvatarBtn').addEventListener('click', () => this.removeAvatar());
        document.getElementById('saveProfileBtn').addEventListener('click', () => this.saveProfile());
        this.refreshUsernameGuard();

        this.loadPreferences();
        this.load2FA();
        this.loadNotificationPrefs();
    }

    handleAvatarFile(file) {
        if (!file) return;
        if (!/^image\//.test(file.type)) {
            this.showToast('Please choose an image file.', true);
            return;
        }
        this.resizeImage(file, 256).then((dataUrl) => {
            if (!dataUrl) {
                this.showToast('Could not read that image.', true);
                return;
            }
            this.saveLocalProfile({ avatar: dataUrl });
            this.refreshAvatarUI();
            this.renderIdentity();
            this.showToast('Profile picture updated.');
        });
    }

    resizeImage(file, max) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onerror = () => resolve(null);
            reader.onload = () => {
                const img = new Image();
                img.onerror = () => resolve(null);
                img.onload = () => {
                    const scale = Math.min(1, max / Math.max(img.width, img.height));
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round(img.width * scale));
                    canvas.height = Math.max(1, Math.round(img.height * scale));
                    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                    resolve(canvas.toDataURL('image/jpeg', 0.85));
                };
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }

    refreshAvatarUI() {
        const local = this.getLocalProfile();
        const preview = document.getElementById('profileAvatarPreview');
        const removeBtn = document.getElementById('removeAvatarBtn');
        if (preview) {
            preview.innerHTML = local.avatar
                ? '<img src="' + local.avatar + '" alt="" style="width:100%;height:100%;object-fit:cover;">'
                : 'U';
        }
        if (removeBtn) removeBtn.style.display = local.avatar ? 'block' : 'none';
    }

    removeAvatar() {
        this.saveLocalProfile({ avatar: '' });
        this.refreshAvatarUI();
        this.renderIdentity();
        this.showToast('Profile picture removed.');
    }

    saveProfile() {
        this.saveLocalProfile({
            displayName: document.getElementById('infoDisplayName').value.trim(),
            email: document.getElementById('infoEmail').value.trim(),
            phone: document.getElementById('infoPhone').value.trim(),
            department: document.getElementById('infoDepartment').value.trim()
        });
        this.renderIdentity();
        const msg = document.getElementById('profileSaveMsg');
        if (msg) {
            msg.style.display = 'inline';
            setTimeout(() => { msg.style.display = 'none'; }, 2500);
        }
    }

    refreshUsernameGuard() {
        const usernameInput = document.getElementById('infoUsername');
        const guard = document.getElementById('usernameChangeGuard');
        if (!usernameInput || !guard) return;
        const saved = (AuthAPI.getCurrentUser() && AuthAPI.getCurrentUser().username) || '';
        const changed = usernameInput.value.trim() !== saved;
        guard.style.display = changed ? 'block' : 'none';
    }

    async saveProfile() {
        const usernameInput = document.getElementById('infoUsername');
        const savedUser = AuthAPI.getCurrentUser() || {};
        const newUsername = usernameInput ? usernameInput.value.trim() : null;

        try {
            if (newUsername && (savedUser.username || '') !== '' && newUsername !== savedUser.username) {
                const password = document.getElementById('profileCurrentPassword').value;
                if (!password) {
                    this.showToast('Enter your current password to change your username.', true);
                    document.getElementById('profileCurrentPassword').focus();
                    return;
                }
                await TicketAPI.changeUsername(newUsername, password);
            }
        } catch (err) {
            this.showToast(err && err.message ? err.message : 'Failed to save profile.', true);
            return;
        }

        this.saveLocalProfile({
            displayName: document.getElementById('infoDisplayName').value.trim(),
            email: document.getElementById('infoEmail').value.trim(),
            phone: document.getElementById('infoPhone').value.trim(),
            department: document.getElementById('infoDepartment').value.trim()
        });
        this.currentUser = AuthAPI.getCurrentUser();
        this.renderIdentity();
        this.renderWelcome();
        if (this.currentSection === 'profile') await this.loadProfile();
        const msg = document.getElementById('profileSaveMsg');
        if (msg) {
            msg.style.display = 'inline';
            setTimeout(() => { msg.style.display = 'none'; }, 2500);
        }
    }

    async handlePasswordChange(e) {
        const form = e.target;
        const currentPassword = document.getElementById('currentPassword').value;
        const newPassword = document.getElementById('newPassword').value;
        const confirmPassword = document.getElementById('confirmPassword').value;

        if (newPassword !== confirmPassword) {
            this.showToast('New password and confirmation do not match.', true);
            return;
        }

        try {
            await TicketAPI.changePassword(currentPassword, newPassword);
            this.showToast('Password updated successfully!');
            form.reset();
        } catch (error) {
            this.showToast(error.message, true);
        }
    }

    // ============ Ticket categories (admin-managed) ============
    async loadCategoryOptions() {
        const select = document.getElementById('category');
        if (!select) return;

        const categories = await TicketAPI.getCategories();
        const currentValue = select.value;

        select.innerHTML = '<option value="">Select category</option>' +
            categories.map(c => `<option value="${c.name}">${this.capitalize(c.name)}</option>`).join('');

        if (currentValue) select.value = currentValue;
    }

    // ============ Offline sync (Phase 2) ============
    setupOfflineSync() {
        // Reconnect → flush the queue; disconnect → show the banner.
        window.addEventListener('online', () => {
            this.updateOfflineBanner();
            this.syncPending();
        });
        window.addEventListener('offline', () => this.updateOfflineBanner());

        // A service-worker message (SW_READY on activate, CACHE_REFRESHED after a
        // successful flush) also triggers a sync attempt.
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', (event) => {
                if (event.data && typeof event.data.type === 'string') this.syncPending();
            });
        }

        // Safety-net poll while online.
        setInterval(() => {
            if (navigator.onLine) this.syncPending();
        }, 60000);

        this.updateOfflineBanner();
        this.updatePendingBadge();
    }

    async enqueueTicket(payload) {
        try {
            await OfflineDB.enqueueTicket(payload);
            await this.updatePendingBadge();
        } catch (error) {
            console.error('Failed to queue ticket offline:', error);
            this.showToast('Could not save offline. Please try again.', true);
        }
    }

    async updatePendingBadge() {
        const badge = document.getElementById('pendingBadge');
        if (!badge) return;
        try {
            const n = await OfflineDB.countPending();
            badge.style.display = n > 0 ? 'inline-flex' : 'none';
            badge.textContent = `${n} pending submission${n === 1 ? '' : 's'}`;
        } catch (error) {
            badge.style.display = 'none';
        }
    }

    updateOfflineBanner() {
        const banner = document.getElementById('offlineBanner');
        if (!banner) return;
        banner.style.display = navigator.onLine ? 'none' : 'flex';
    }

    formatClock(date) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    // Only called on a genuine server round-trip (never on cache-served data).
    markSynced() {
        const el = document.getElementById('lastSynced');
        if (el) el.textContent = `last synced: ${this.formatClock(new Date())}`;
    }

    // Ask the SW to evict cached ticket lists after a successful flush so the
    // next page request re-caches fresh data instead of serving stale cache.
    refreshTicketCache() {
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({ type: 'REFRESH_TICKETS_CACHE' });
        }
    }

    async syncPending() {
        if (!navigator.onLine) return;
        if (this.syncing) return;
        this.syncing = true;
        try {
            let pending = [];
            try {
                pending = await OfflineDB.getPending();
            } catch (error) {
                console.error('Could not read offline queue:', error);
                return;
            }
            if (pending.length === 0) return;

            // Fresh access token before replay. On failure (offline or a revoked
            // refresh token) every item stays queued and the user is told.
            try {
                await AuthAPI.refreshToken();
            } catch (refreshError) {
                AuthAPI.onSessionExpired();
                return;
            }

            let submitted = 0;
            for (const item of pending) {
                const result = await TicketAPI.createTicketOffline(item);
                if (result.ok) {
                    // 201 (new) or 200 (idempotent replay) both mean it's on the server.
                    await OfflineDB.removePending(item.client_uuid);
                    submitted++;
                } else if (result.network) {
                    // Network dropped again mid-flush — leave this one queued.
                    continue;
                } else {
                    // 4xx/5xx: the server rejected this payload on its merits.
                    // Drop it permanently instead of retrying a rejected ticket.
                    await OfflineDB.removePending(item.client_uuid);
                    console.error(
                        `Offline ticket rejected (HTTP ${result.status}) and removed from the queue:`,
                        item, result.data
                    );
                }
            }

            await this.updatePendingBadge();
            if (submitted > 0) {
                this.refreshTicketCache();
                this.markSynced();
                await this.loadTickets();
                this.renderPersonalDashboard();
                this.showToast(`${submitted} offline submission${submitted === 1 ? '' : 's'} submitted.`);
                // IDLE — costs money when enabled (paid push provider).
                this.maybePushNotify({ type: 'offline_tickets_submitted', count: submitted });
            }
        } finally {
            this.syncing = false;
        }
    }

    showToast(message, isError = false) {
        const toast = document.createElement('div');
        toast.className = 'toast' + (isError ? ' error' : '');
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    // IDLE — costs money when enabled (paid push provider).
    // Reads window.__PUSH_ENABLED, a runtime flag injected in user/index.html.
    // When false, returns immediately and makes NO network call. When true, it
    // pings the placeholder subscription endpoint — that endpoint does NOT need
    // to exist yet: any HTTP error (404 included) is handled gracefully.
    maybePushNotify(event) {
        if (window.__PUSH_ENABLED !== true) return;
        fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event || {})
        }).catch(() => {});
    }
}

// ============ Offline queue: IndexedDB wrapper ============
// DB: ict_offline, store: pending_tickets (keyPath: client_uuid).
// Nothing here touches the network or auth tokens — pure local persistence.
const OfflineDB = {
    _db: null,

    _open() {
        if (this._db) return Promise.resolve(this._db);
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('ict_offline', 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('pending_tickets')) {
                    db.createObjectStore('pending_tickets', { keyPath: 'client_uuid' });
                }
            };
            request.onsuccess = () => {
                this._db = request.result;
                this._db.onversionchange = null;
                resolve(this._db);
            };
            request.onerror = () => {
                this._db = null;
                reject(request.error);
            };
        });
    },

    async enqueueTicket(payload) {
        const db = await this._open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('pending_tickets', 'readwrite');
            tx.objectStore('pending_tickets').put(payload);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    async getPending() {
        const db = await this._open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('pending_tickets', 'readonly');
            const request = tx.objectStore('pending_tickets').getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    },

    async removePending(clientUuid) {
        const db = await this._open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('pending_tickets', 'readwrite');
            tx.objectStore('pending_tickets').delete(clientUuid);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    async countPending() {
        const db = await this._open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('pending_tickets', 'readonly');
            const request = tx.objectStore('pending_tickets').count();
            request.onsuccess = () => resolve(request.result || 0);
            request.onerror = () => reject(request.error);
        });
    }
};

// ============ Sidebar (YouTube-style three states, persistent) ============
// Sidebar states (YouTube-style three-state behaviour):
//   Expanded (full) <-> Mini (icon rail) on wide screens (>1024px).
//   The 769-1024px band is Mini-fixed; the hamburger opens Expanded as an
//   overlay there. <=768px the sidebar is Hidden; the hamburger toggles an
//   overlay drawer.
//   The user's chosen desktop state ('expanded'|'mini') persists in
//   localStorage 'sidebar:state' and is only ever written by an explicit
//   hamburger click — never by a resize. Legacy 'sidebarMode' / session
//   'sidebarCollapsed' values migrate to it.
//   Classes live on <html>, matching the pre-paint <head> bootstrap:
//   .sidebar-mini (effective Mini), .sidebar-expanded-overlay (mid-size
//   overlay), .sidebar-mobile-open (mobile drawer + body scroll lock).
var SidebarManager = (function () {
    var STATE_KEY = 'sidebar:state';
    var BREAKPOINT_MOBILE = 768;
    var BREAKPOINT_WIDE = 1025;
    var remembered = 'expanded';
    var drawerOpen = false;      // <=768px overlay drawer
    var expandedOverlay = false; // 769-1024px overlay

    function matches(query) {
        try { return window.matchMedia(query).matches; } catch (e) { return false; }
    }

    function isMobile() { return matches('(max-width: ' + BREAKPOINT_MOBILE + 'px)'); }
    function isWide() { return matches('(min-width: ' + BREAKPOINT_WIDE + 'px)'); }

    function readRemembered() {
        try {
            var v = localStorage.getItem(STATE_KEY);
            if (v === 'expanded' || v === 'mini') return v;
            if (localStorage.getItem('sidebarMode') === 'rail') return 'mini';
            if (sessionStorage.getItem('sidebarCollapsed') === 'true') return 'mini';
        } catch (e) { /* storage unavailable - fall through */ }
        return 'expanded';
    }

    function writeRemembered(m) {
        try { localStorage.setItem(STATE_KEY, m); } catch (e) { /* non-fatal */ }
    }

    function apply() {
        var el = document.documentElement;
        var small = isMobile();
        var wide = isWide();
        el.classList.toggle('sidebar-mobile-open', small && drawerOpen);
        el.classList.toggle('sidebar-expanded-overlay', !small && !wide && expandedOverlay);
        el.classList.toggle('sidebar-mini', small ? false : (wide ? remembered === 'mini' : !expandedOverlay));
        var btn = document.getElementById('toggleSidebar');
        var btnMobile = document.getElementById('toggleSidebarMobile');
        var expanded = small ? drawerOpen : (!wide ? expandedOverlay : remembered === 'expanded');
        if (btn) btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (btnMobile) btnMobile.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }

    function focusSidebar() {
        var el = document.getElementById('sidebar');
        if (el && typeof el.focus === 'function') el.focus();
    }

    function focusToggle() {
        var btn = matches('(max-width: 1024px)')
            ? document.getElementById('toggleSidebarMobile')
            : document.getElementById('toggleSidebar');
        if (btn && typeof btn.focus === 'function') btn.focus();
    }

    function closeOverlay(returnFocus) {
        var wasOpen = drawerOpen || expandedOverlay;
        drawerOpen = false;
        expandedOverlay = false;
        apply();
        if (wasOpen && returnFocus) focusToggle();
    }

    function toggle() {
        if (isMobile()) {
            drawerOpen = !drawerOpen;
            apply();
            if (drawerOpen) focusSidebar();
            else focusToggle();
        } else if (isWide()) {
            remembered = (remembered === 'mini') ? 'expanded' : 'mini';
            writeRemembered(remembered);
            apply();
        } else {
            expandedOverlay = !expandedOverlay;
            apply();
            if (expandedOverlay) focusSidebar();
            else focusToggle();
        }
    }

    function init() {
        if (!document.getElementById('sidebar')) return;

        remembered = readRemembered();
        drawerOpen = false;
        expandedOverlay = false;

        // Flyout labels (Mini state) come straight from each item's label.
        document.querySelectorAll('.sidebar-nav li').forEach(function (item) {
            var span = item.querySelector('span');
            if (span && span.textContent && !item.getAttribute('data-label')) {
                item.setAttribute('data-label', span.textContent);
            }
        });

        var btn = document.getElementById('toggleSidebar');
        var btnMobile = document.getElementById('toggleSidebarMobile');
        var backdrop = document.getElementById('sidebarBackdrop');

        if (btn) btn.addEventListener('click', toggle);
        if (btnMobile) btnMobile.addEventListener('click', toggle);
        if (backdrop) backdrop.addEventListener('click', function () {
            closeOverlay(true);
        });

        document.addEventListener('keydown', function (e) {
            if ((e.key || '').toLowerCase() !== 'escape') return;
            if (drawerOpen || expandedOverlay) closeOverlay(true);
        });

        document.querySelectorAll('.sidebar-nav li').forEach(function (item) {
            // Choosing a section closes any open overlay afterwards.
            item.addEventListener('click', function () {
                if (drawerOpen || expandedOverlay) closeOverlay(false);
            });
            // Keyboard activation for the focusable nav items.
            item.addEventListener('keydown', function (e) {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                if (document.activeElement !== item) return;
                e.preventDefault();
                item.click();
            });
        });

        // Resize recomputes the effective state. The remembered desktop
        // state is never overwritten here — only explicit clicks persist.
        var resizeTimer = null;
        window.addEventListener('resize', function () {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () {
                expandedOverlay = false;
                drawerOpen = false;
                apply();
            }, 150);
        });

        apply();
    }

    return { init: init };
})();

let app;
document.addEventListener('DOMContentLoaded', () => {
    Icons.hydrate();
    SidebarManager.init();
    app = new TicketingApp();
});
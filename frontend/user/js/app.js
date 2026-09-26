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
        this._dialogOpener = null;
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
        // Fetch the account's server-side photo, then re-render so a device
        // that has never chosen a picture here still shows the stored one.
        this.loadServerAvatar().then(() => this.renderIdentity());
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
            this.refreshNotificationCounts();
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

        ['title', 'description', 'category'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', () => this.previewDerivedPriority());
            if (el) el.addEventListener('change', () => this.previewDerivedPriority());
        });
        this.previewDerivedPriority();

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
        // The picture card is static markup in the document, so its listeners
        // are attached once here rather than on every profile render.
        this.setupPictureDialog();
        this.setupAccountDialog();
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

        const pageTitle = document.getElementById('pageTitle');
        const pageTitleText = SECTION_TITLES[sectionId] || 'Dashboard';
        pageTitle.textContent = pageTitleText;
        pageTitle.title = pageTitleText;
        document.title = pageTitleText + ' — E-Ticketing';
        this.currentSection = sectionId;

        if (sectionId === 'dashboard') this.renderPersonalDashboard();
        if (sectionId === 'tickets') this.filterTickets();
        if (sectionId === 'knowledge') this.loadKnowledgeArticles();
        if (sectionId === 'profile') this.loadProfile();
    }

    // ============ Session expired dialog (Shared module) ============
    initSessionExpiredDialog() {
        if (typeof SessionExpiredDialog !== 'undefined') {
            SessionExpiredDialog.init();
        } else {
            AuthAPI.setOnSessionExpired(() => {
                if (typeof showToast === 'function') showToast('Session expired. Please log in again.', 'error');
            });
        }
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
                    <strong>${escapeHtml(t.title)}</strong>
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
                <td data-label="Ticket #"><strong>${escapeHtml(ticket.ticket_number)}</strong></td>
                <td data-label="Title">${escapeHtml(ticket.title)}</td>
                <td data-label="Category">${escapeHtml(this.capitalize(ticket.category))}</td>
                <td data-label="Priority"><span class="priority-badge ${ticket.priority}">${this.capitalize(ticket.priority)}</span></td>
                <td data-label="Status"><span class="status-badge ${ticket.status}">${this.capitalize(ticket.status.replace('_', ' '))}</span></td>
                <td data-label="Assigned To">${escapeHtml(ticket.assigned_to || 'Unassigned')}</td>
                <td data-label="Created">${new Date(ticket.created_at).toLocaleDateString()}</td>
                <td data-label="Actions">
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
        <h2 style="margin-bottom:5px;">${escapeHtml(ticket.title)}</h2>
        <p style="color:#999;margin-bottom:20px;">${ticket.ticket_number}</p>

        <div style="display:flex;gap:10px;margin-bottom:20px;">
            <span class="status-badge ${ticket.status}">${this.capitalize(ticket.status.replace('_', ' '))}</span>
            <span class="priority-badge ${ticket.priority}">${this.capitalize(ticket.priority)} priority</span>
        </div>

        ${ticket.priority_explanation && ticket.priority_source ? `<div class="priority-cause" style="margin-bottom:20px;">
            <strong>Priority reason (${this.capitalize(ticket.priority_source.replace('_', ' '))}):</strong>
            <p style="margin:4px 0 0;color:var(--text-muted);">${escapeHtml(ticket.priority_explanation)}</p>
        </div>` : ''}

        <p style="margin-bottom:15px;"><strong>Category:</strong> ${escapeHtml(this.capitalize(ticket.category))}</p>
        <p style="margin-bottom:15px;"><strong>Assigned To:</strong> ${escapeHtml(ticket.assigned_to || 'Unassigned')}</p>
        <p style="margin-bottom:20px;"><strong>Description:</strong><br>${escapeHtml(ticket.description)}</p>

        ${ticket.resolution ? `<p style="margin-bottom:20px;"><strong>Resolution:</strong><br>${escapeHtml(ticket.resolution)}</p>` : ''}

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
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(a.original_filename)}</span>
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
    if (navigator.onLine === false) {
        container.innerHTML = '<p style="color:#999;font-size:0.9rem;">Requires connection — replies will load when you are back online.</p>';
        return;
    }
    const comments = await TicketAPI.getTicketComments(ticketId);

    if (comments.length === 0) {
        container.innerHTML = '<p style="color:#999;font-size:0.9rem;">No replies yet. Start the conversation below.</p>';
        return;
    }

    container.innerHTML = comments.map(c => `
        <div style="padding:10px 0;border-bottom:1px solid #f5f5f5;">
            <div style="display:flex;justify-content:space-between;">
                <strong style="font-size:0.9rem;">${escapeHtml(c.author_username)}</strong>
                <span style="font-size:0.75rem;color:#999;">${new Date(c.created_at).toLocaleString()}</span>
            </div>
            <p style="margin-top:4px;font-size:0.9rem;">${escapeHtml(c.message)}</p>
        </div>
    `).join('');
}

    async handleCommentSubmit() {
        const input = document.getElementById('commentInput');
        const message = input.value.trim();
        if (!message || !this.activeTicketId) return;

        // Stamp one uuid now so the queued copy and any replay reuse the SAME
        // uuid — the server dedups on it, so an offline comment can never land
        // twice even if a commit landed but its response was lost.
        const itemUuid = TicketAPI.generateClientUuid();

        // createTicketCommentOffline attaches the client_uuid and classifies the
        // outcome: ok / network failure (retryable, queued) / HTTP error.
        const result = await TicketAPI.createTicketCommentOffline(this.activeTicketId, message, false, itemUuid);

        if (result.ok) {
            input.value = '';
            this.showToast('Reply posted.');
            await this.loadTicketComments(this.activeTicketId);
            this.refreshTicketCache();
        } else if (result.network) {
            // Offline or server unreachable — the exact payload (with its
            // client_uuid) is kept locally and submitted by the sync loop.
            await this.enqueueComment({
                client_uuid: itemUuid,
                ticket_id: this.activeTicketId,
                message: message,
                is_internal: false
            });
            input.value = '';
            this.showToast('Saved offline — will send when online.');
        } else {
            if (result.status === 401 || result.status === 422) {
                AuthAPI.onSessionExpired();
            } else {
                this.showToast(result.error.message || 'Failed to post reply. Please try again.', true);
            }
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

    // Live preview of the system-assigned initial priority. Uses the same
    // client-side evaluator + cached rule config as the offline queue, so the
    // preview matches what the server derives while online and what the local
    // queue stamps while offline.
    previewDerivedPriority() {
        const box = document.getElementById('priorityDerived');
        if (!box) return;
        const title = (document.getElementById('title').value || '').trim();
        const description = (document.getElementById('description').value || '').trim();
        const category = (document.getElementById('category').value || '').trim();

        if (!title && !description && !category) {
            box.innerHTML = `<span class="priority-badge medium">Medium</span>
                    <span class="priority-derived-note">Will be derived automatically from your description.</span>`;
            return;
        }

        const me = this.currentUser || null;
        const evidence = {
            title,
            description,
            category,
            department: undefined,
            role: (me && me.role) ? me.role : 'staff',
            created_at: new Date().toISOString()
        };
        const cache = TicketAPI.getCachedPriorityConfig();
        const config = cache && cache.config ? cache.config : TicketAPI.getBuiltinPriorityConfig();
        const result = TicketAPI.evaluatePriorityClient(evidence, config);
        const cap = String(result.priority).charAt(0).toUpperCase() + String(result.priority).slice(1);
        const reason = result.fallback
            ? 'No configured rule matched — using the system default.'
            : `Matched: ${escapeHtml(result.rule_name || 'a rule')}.`;
        const version = result.rules_version === 'builtin' ? 'built-in rules' : `rule version ${escapeHtml(String(result.rules_version))}`;
        box.innerHTML = `<span class="priority-badge ${result.priority}">${cap}</span>
                    <span class="priority-derived-note">${reason} Using ${version}.</span>`;
    }

    // ============ Knowledge Base ============
    async loadKnowledgeArticles() {
        const query = document.getElementById('kbSearch').value;
        const category = document.getElementById('kbCategoryFilter').value;
        const container = document.getElementById('kbArticleList');
        container.innerHTML = `<p style="color:#999;">${Icons.render('spinner', { state: 'loading' })} Searching...</p>`;

        const meta = await TicketAPI.getKnowledgeArticlesWithMeta(query, category);

        if (!meta.ok && !meta.fromCache) {
            container.innerHTML = `
                <div class="empty-state">
                    ${Icons.render('wifi')}
                    <p>Requires connection to load the knowledge base.</p>
                    <p style="font-size:0.85rem;color:var(--text-muted,#999);">Articles you have opened before load automatically when you are back online.</p>
                    <button type="button" class="btn-secondary btn-sm" onclick="app.loadKnowledgeArticles()" style="margin-top:12px;">Retry</button>
                </div>
            `;
            return;
        }

        this.renderKnowledgeArticles(meta.articles);
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
                    <h3 style="margin:0;">${escapeHtml(a.title)}</h3>
                    <span class="status-badge open">${escapeHtml(this.capitalize(a.category))}</span>
                </div>
                <div id="kb-article-${a.id}" style="display:none;margin-top:15px;color:#555;line-height:1.6;">
                    ${escapeHtml(a.content)}
                </div>
                <div style="margin-top:10px;font-size:0.75rem;color:#999;">
                    ${a.author_username ? `By ${escapeHtml(a.author_username)}` : ''}${a.updated_at ? ` &middot; Updated ${new Date(a.updated_at).toLocaleDateString()}` : ''}
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
            const cached = await this.loadNotificationsCache();
            if (cached) {
                this.notificationsOffline = true;
                this.notifications = cached.notifications || [];
                this.notificationUnread = cached.unread_count || 0;
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
        this.refreshNotificationCounts();
        this.renderNotificationList();
    }

    // Unread counts come from the category-filtered list so a disabled
    // category disappears from the bell badge/pill too, not just the list.
    refreshNotificationCounts() {
        const visible = this.visibleNotifications();
        this.notificationUnread = visible.filter(n => !n.is_read).length;
        this.renderNotificationBadge(this.notificationUnread);
        this.updateNotificationUnreadUI();
    }

    saveNotificationsCache() {
        try {
            if (typeof OfflineDB === 'undefined' || !OfflineDB.cachePut) return;
            const username = this.currentUser ? this.currentUser.username : '';
            OfflineDB.cachePut('ntf_cache', {
                notifications: this.notifications,
                unread_count: this.notificationUnread
            }, username);
        } catch (e) { /* storage unavailable: offline rendering degrades gracefully */ }
    }

    async loadNotificationsCache() {
        try {
            if (typeof OfflineDB === 'undefined' || !OfflineDB.cacheGet) return null;
            const record = await OfflineDB.cacheGet('ntf_cache');
            if (!record || !record.data) return null;
            const expectedUser = this.currentUser ? this.currentUser.username : '';
            if (record.user !== expectedUser) return null;
            return {
                notifications: record.data.notifications || [],
                unread_count: record.data.unread_count || 0,
                at: record.at || 0
            };
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

    async renderLastSynced() {
        const el = document.getElementById('notificationLastSynced');
        if (!el) return;
        const cache = await this.loadNotificationsCache();
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

        // Drop the offline queue + caches (IndexedDB). In-flight writes are
        // discarded when the database is deleted.
        if (window.OfflineDB) OfflineDB.deleteDb();

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
        // The server is now the source of truth for the three fields
        // PUT /api/users/me owns (display name, email, phone). The local copy
        // is only a cache for a device that has fetched once and is now
        // offline, so it is the fallback rather than the winner. The backend
        // sends display_name in snake_case.
        const serverName = user.display_name || user.displayName || '';
        const serverEmail = user.email || '';
        const serverPhone = user.phone || '';
        return {
            displayName: serverName || local.displayName || user.username || user.email || '',
            username: user.username || local.username || '',
            email: serverEmail || local.email || '',
            role: user.role || local.role || '',
            phone: serverPhone || local.phone || '',
            department: user.department || local.department || '',
            // The locally-saved data URL wins, because it renders with the
            // network off (O8). The server copy is the fallback for a device
            // that has never had a picture chosen here. The path is stored
            // rather than the full URL so the current token is re-applied on
            // every render instead of going stale.
            // Also check the server's avatar_url from the API response.
            avatar: local.avatar || avatarUrl(user) || avatarUrl({ avatar_url: local.avatarPath }) || '',
            // Emoji avatar, cached locally for the same reason the picture is:
            // it must render with the network off (O8). Precedence is decided
            // by the caller as photo, then emoji, then monogram.
            avatarEmoji: local.avatarEmoji || user.avatar_emoji || ''
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
            } else if (eff.avatarEmoji) {
                // The glyph is decorative: the name sits right beside it.
                avatarEl.textContent = eff.avatarEmoji;
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

    // The user portal's Account Information card. Same panel, same field set
    // and same behaviour as the admin portal's, so the two read identically.
    // Differences that are real, not cosmetic:
    //   - Username stays editable, because a user can genuinely rename
    //     themselves through PUT /api/users/me/username with a password
    //     check. The admin card shows it readonly.
    //   - Department is readonly here: the server assigns it, and
    //     PUT /api/users/me ignores the key.
    async loadProfile() {
        const container = document.getElementById('accountInfo');
        if (!container) return;

        const profile = await TicketAPI.getMyProfile();
        if (!profile) {
            // OFF4: an honest state, not a blank and not a spinner that never
            // resolves. The card cannot render without knowing who you are.
            container.innerHTML = '<p class="profile-note">Your profile could not be loaded. It needs a connection to the server the first time you open it.</p>';
            return;
        }

        const eff = this.getEffectiveProfile(profile);
        const initial = (eff.displayName || eff.username || 'U').charAt(0).toUpperCase();
        const esc = (v) => this._esc(v == null ? '' : v);

        container.innerHTML = `
            <div class="account-info-card user-profile-card">
                <div class="panel">
                    <aside class="side">
                        <div class="avatar-wrap">
                            <button type="button" class="avatar-btn" id="userInfoAvatarBtn" aria-label="Change profile picture"
                                    aria-haspopup="dialog" aria-controls="pictureModal">
                                <span class="visual" id="userInfoAvatarVisual" aria-hidden="true"></span>
                                <span class="avatar-overlay" aria-hidden="true"><i data-icon="camera"></i></span>
                            </button>
                            <button type="button" class="cam-badge" id="userInfoCamBadge" aria-label="Change profile picture"
                                    aria-haspopup="dialog" aria-controls="pictureModal">
                                <i data-icon="camera" aria-hidden="true"></i>
                            </button>
                        </div>

                        <div class="id-block">
                            <div class="name-display" id="userProfileName">${esc(eff.displayName)}</div>
                            <div class="handle-display" id="userProfileHandle">@${esc(eff.username)}</div>
                            <span class="role-tag" id="userProfileRole">${esc(this._titleise(eff.role))}</span>
                        </div>

                        <div class="preview">
                            <div>
                                <p class="p-label">In the sidebar</p>
                                <div class="chip">
                                    <div class="mini-avatar" id="userPreviewSidebarAvatar" aria-hidden="true"></div>
                                    <span class="chip-text" id="userPreviewSidebarName">${esc(eff.displayName)}</span>
                                </div>
                            </div>
                            <div>
                                <p class="p-label">On a ticket</p>
                                <div class="chip">
                                    <div class="mini-avatar" id="userPreviewTicketAvatar" aria-hidden="true"></div>
                                    <span class="chip-text" id="userPreviewTicketName">No tickets yet</span>
                                    <span class="chip-sub" id="userPreviewTicketSub">As the person who raised it</span>
                                </div>
                            </div>
                        </div>
                    </aside>

                    <div class="form-side">
                        <h1 id="userProfileHeading">Account Information</h1>
                        <p class="sub">Update your display name and contact details. Your picture and emoji are shared with everyone.</p>

                        <div class="frow">
                            <label for="infoDisplayName">Display Name</label>
                            <div class="field-wrap">
                                <input type="text" id="infoDisplayName" value="${esc(eff.displayName)}" autocomplete="name" aria-describedby="infoDisplayNameHelp">
                                <p class="help" id="infoDisplayNameHelp">Shown in the sidebar and on your tickets</p>
                            </div>
                        </div>
                        <div class="frow">
                            <label for="infoPhone">Phone</label>
                            <div class="field-wrap">
                                <input type="tel" id="infoPhone" value="${esc(eff.phone)}" placeholder="e.g. +254 7XX XXX XXX" autocomplete="tel" aria-describedby="infoPhoneHelp">
                                <p class="help" id="infoPhoneHelp">Used to reach you about a ticket. Leave empty to remove it.</p>
                            </div>
                        </div>
                        <div class="frow">
                            <label for="infoDepartment">Department</label>
                            <div class="field-wrap">
                                <input type="text" id="infoDepartment" value="${esc(eff.department)}" readonly aria-describedby="infoDepartmentHelp">
                                <p class="help" id="infoDepartmentHelp">Assigned by your administrator</p>
                            </div>
                        </div>
                        <div class="frow">
                            <label for="infoUsername">Username</label>
                            <div class="field-wrap">
                                <input type="text" id="infoUsername" value="${esc(eff.username)}" maxlength="50" minlength="2" autocomplete="username" aria-describedby="infoUsernameHelp">
                                <p class="help" id="infoUsernameHelp">Your sign-in name. Changing it needs your password.</p>
                            </div>
                        </div>
                        <div class="frow">
                            <label for="infoEmail">Email</label>
                            <div class="field-wrap">
                                <input type="email" id="infoEmail" value="${esc(eff.email)}" autocomplete="email" aria-describedby="infoEmailHelp">
                                <p class="help" id="infoEmailHelp">Where ticket updates are sent. Leave empty to remove it.</p>
                            </div>
                        </div>
                        <div class="frow">
                            <label for="infoRole">Role</label>
                            <div class="field-wrap">
                                <input type="text" id="infoRole" value="${esc(this._titleise(eff.role))}" readonly aria-describedby="infoRoleHelp">
                                <p class="help" id="infoRoleHelp">Assigned by your administrator</p>
                            </div>
                        </div>

                        <div id="usernameChangeGuard" class="username-guard" hidden>
                            <div class="form-group password-field" data-password-field data-mode="enter">
                                <label for="profileCurrentPassword">Current Password</label>
                                <input type="password" id="profileCurrentPassword" autocomplete="current-password">
                            </div>
                            <p class="profile-note">Required when you change your username.</p>
                        </div>

                        <div class="footer">
                            <span class="unsaved" id="userProfileUnsaved"><span class="dot" aria-hidden="true"></span>Unsaved changes</span>
                            <span class="profile-save-msg" id="profileSaveMsg" role="status" aria-live="polite"><span id="profileSaveMsgText">Saved.</span></span>
                            <button type="button" class="save-btn" id="saveProfileBtn">Save Changes</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        this._renderUserAvatarDiscs(eff, initial);
        this._renderUserTicketPreview(eff, initial);
        this._wireUserProfileCard();

        if (window.PasswordField) PasswordField.refresh(container);

        this.loadPreferences();
        this.load2FA();
        this.loadNotificationPrefs();
    }

    _titleise(value) {
        const v = (value || '').toString();
        return v ? v.charAt(0).toUpperCase() + v.slice(1) : '';
    }

    // Photo, then emoji, then monogram - the same precedence as the admin
    // card, drawn into the same three hosts.
    _fillUserAvatarDisc(el, src, emoji, initial) {
        const useEmoji = !src && emoji;
        el.textContent = '';
        if (src) {
            const img = document.createElement('img');
            img.src = src;
            img.alt = '';
            img.setAttribute('aria-hidden', 'true');
            img.addEventListener('error', () => this._fillUserAvatarDisc(el, '', emoji, initial));
            el.appendChild(img);
        } else if (useEmoji) {
            const span = document.createElement('span');
            span.className = 'user-avatar-emoji';
            span.setAttribute('aria-hidden', 'true');
            span.textContent = emoji;
            el.appendChild(span);
        } else {
            const span = document.createElement('span');
            span.className = 'initials-txt';
            span.setAttribute('aria-hidden', 'true');
            span.textContent = initial;
            el.appendChild(span);
        }
    }

    _renderUserAvatarDiscs(eff, initial) {
        const src = eff.avatar;
        const emoji = eff.avatarEmoji;
        ['userInfoAvatarVisual', 'userPreviewSidebarAvatar', 'userPreviewTicketAvatar']
            .forEach((id) => {
                const el = document.getElementById(id);
                if (el) this._fillUserAvatarDisc(el, src, emoji, initial);
            });
        this._syncUserPictureButtons();
    }

    // The ticket row only appears if the signed-in user really did raise one.
    // Otherwise it says so rather than inventing a ticket number (S2).
    _renderUserTicketPreview(eff, initial) {
        const me = (this.currentUser && this.currentUser.username) || eff.username;
        const ticket = (this.tickets || []).find(t => t.created_by === me);
        const name = document.getElementById('userPreviewTicketName');
        const sub = document.getElementById('userPreviewTicketSub');
        const disc = document.getElementById('userPreviewTicketAvatar');
        if (name) name.textContent = ticket ? (ticket.ticket_number || 'A ticket') : 'No tickets yet';
        if (sub) sub.textContent = ticket ? 'As the person who raised it' : 'As the person who raised it';
        if (disc) {
            if (ticket) {
                this._fillUserAvatarDisc(disc, eff.avatar, eff.avatarEmoji, initial);
            } else {
                disc.textContent = '';
            }
        }
    }

    // The identity column mirrors the live form, so the two can never drift
    // apart while the name is being typed.
    _syncUserProfileIdentity() {
        const nameField = document.getElementById('infoDisplayName');
        const userField = document.getElementById('infoUsername');
        const fallback = (this.currentUser && this.currentUser.username) || '';
        if (nameField) {
            const shown = nameField.value.trim() || 'Your name';
            const hero = document.getElementById('userProfileName');
            if (hero) hero.textContent = shown;
            const chip = document.getElementById('userPreviewSidebarName');
            if (chip) chip.textContent = shown;
        }
        if (userField) {
            const handle = document.getElementById('userProfileHandle');
            if (handle) handle.textContent = '@' + (userField.value.trim() || fallback);
        }
    }

    _setUserProfileUnsaved(dirty) {
        const el = document.getElementById('userProfileUnsaved');
        if (el) el.classList.toggle('show', !!dirty);
    }

    _wireUserProfileCard() {
        const card = document.getElementById('accountInfo');
        if (!card) return;

        // Avatar and camera badge both open the picture options card.
        ['userInfoAvatarBtn', 'userInfoCamBadge'].forEach((id) => {
            const btn = document.getElementById(id);
            if (btn) btn.addEventListener('click', () => this.openPictureDialog(id));
        });

        // setDirty on every editable row. Department and Role are readonly, so
        // they can never emit input or change and are skipped.
        card.querySelectorAll('.frow input').forEach((field) => {
            if (field.readOnly || field.disabled) return;
            field.addEventListener('input', () => this._setUserProfileUnsaved(true));
            field.addEventListener('change', () => this._setUserProfileUnsaved(true));
        });
        ['infoDisplayName', 'infoUsername'].forEach((id) => {
            const field = document.getElementById(id);
            if (field) field.addEventListener('input', () => this._syncUserProfileIdentity());
        });
        this._syncUserProfileIdentity();
        this.refreshUsernameGuard();
        this._setUserProfileUnsaved(false);

        const saveBtn = document.getElementById('saveProfileBtn');
        if (saveBtn) saveBtn.addEventListener('click', () => this.saveProfile());
    }

    // ============ Picture options ============
    // Same card as the admin portal's: a sibling overlay with a back arrow,
    // opened from the avatar or the camera badge.




    _syncUserPictureButtons() {
        const local = this.getLocalProfile();
        const removeBtn = document.getElementById('userRemoveAvatarBtn');
        const clearEmojiBtn = document.getElementById('userEmojiClearBtn');
        if (removeBtn) removeBtn.classList.toggle('is-hidden', !local.avatar);
        if (clearEmojiBtn) clearEmojiBtn.classList.toggle('is-hidden', !local.avatarEmoji);
    }



    // Saves through PUT /api/users/me. The local copy is still written, but
    // only as a cache for offline rendering - it is no longer the save.


    // ============ Picture options ============
    // The picture card is a plain overlay on the page: the Account Information
    // card is a page section here, not a dialog, so unlike the admin portal
    // there is no second dialog underneath to stack on. The behaviour is the
    // same card otherwise: back arrow, backdrop, Escape, focus return, trap.
    _trapPictureFocus(e, modal) {
        if (e.key !== 'Tab' || !modal || modal.style.display === 'none') return;
        const focusable = Array.prototype.filter.call(
            modal.querySelectorAll(
                'button:not([disabled]), [href], input:not([disabled]), '
                + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'),
            el => el.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }

    // openerId is the control that opened the card, so focus can return to it
    // on close rather than dropping the user at the top of the document.
    openPictureDialog(openerId) {
        const modal = document.getElementById('pictureModal');
        if (!modal) return;
        this._pictureOpener = openerId
            ? document.getElementById(openerId)
            : document.activeElement;
        modal.style.display = 'block';
        this._syncUserPictureButtons();
        const back = document.getElementById('pictureModalBack');
        if (back) back.focus();
    }

    closePictureDialog() {
        const modal = document.getElementById('pictureModal');
        if (!modal || modal.style.display === 'none') return;
        // The emoji panel is nested inside the card, so it must not survive it.
        const panel = document.getElementById('userEmojiPanel');
        const toggle = document.getElementById('userEmojiAvatarBtn');
        if (panel) panel.hidden = true;
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
        modal.style.display = 'none';
        const opener = this._pictureOpener;
        this._pictureOpener = null;
        if (opener && opener.isConnected && typeof opener.focus === 'function') {
            opener.focus();
        } else {
            const fallback = document.getElementById('userInfoAvatarBtn');
            if (fallback) fallback.focus();
        }
    }

    setupPictureDialog() {
        const modal = document.getElementById('pictureModal');
        if (!modal) return;

        const back = document.getElementById('pictureModalBack');
        if (back) back.addEventListener('click', () => this.closePictureDialog());
        // Matched on the overlay itself, so a click inside the card cannot
        // close it.
        modal.addEventListener('click', (e) => {
            if (e.target === modal) this.closePictureDialog();
        });
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                // The card is a sibling of the page content, so stop the press
                // here rather than let it reach a handler behind the card.
                e.stopPropagation();
                // Escape unwinds the emoji picker before the card (MOD5).
                const panel = document.getElementById('userEmojiPanel');
                const toggle = document.getElementById('userEmojiAvatarBtn');
                if (panel && !panel.hidden) {
                    panel.hidden = true;
                    if (toggle) {
                        toggle.setAttribute('aria-expanded', 'false');
                        toggle.focus();
                    }
                    return;
                }
                this.closePictureDialog();
                return;
            }
            this._trapPictureFocus(e, modal);
        });

        const upload = document.getElementById('userUploadAvatarBtn');
        if (upload) {
            upload.addEventListener('click', () => {
                const input = document.getElementById('userAvatarFileInput');
                if (input) input.click();
            });
        }
        const input = document.getElementById('userAvatarFileInput');
        if (input) {
            input.addEventListener('change', (e) => {
                this.handleAvatarFile(e.target.files && e.target.files[0]);
                e.target.value = '';
                this.closePictureDialog();
            });
        }
        const remove = document.getElementById('userRemoveAvatarBtn');
        if (remove) {
            remove.addEventListener('click', () => {
                this.removeAvatar();
                this.closePictureDialog();
            });
        }
        const clearEmoji = document.getElementById('userEmojiClearBtn');
        if (clearEmoji) {
            clearEmoji.addEventListener('click', () => {
                this.clearEmojiAvatar();
                this.closePictureDialog();
            });
        }

        // Emoji picker, rendered once now that the markup exists. If the shared
        // script did not load, hide the control rather than offer a dead button.
        const toggle = document.getElementById('userEmojiAvatarBtn');
        const panel = document.getElementById('userEmojiPanel');
        if (window.EmojiPicker && toggle && panel) {
            window.EmojiPicker.render(
                document.getElementById('userEmojiChoices'),
                (emoji) => {
                    this.setEmojiAvatar(emoji);
                    panel.hidden = true;
                    toggle.setAttribute('aria-expanded', 'false');
                });
        } else if (toggle) {
            toggle.classList.add('is-hidden');
        }
        if (toggle && panel) {
            toggle.addEventListener('click', () => {
                const opening = panel.hidden;
                panel.hidden = !opening;
                toggle.setAttribute('aria-expanded', String(opening));
            });
        }
    }

    setupAccountDialog() {
        const launcher = document.getElementById('identityLauncher');
        const modal = document.getElementById('accountModal');
        if (!launcher || !modal) return;

        launcher.addEventListener('click', () => this.openAccountDialog());
        launcher.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.openAccountDialog();
            }
        });

        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                this._closeDialog(modal);
                return;
            }
            this._trapDialogFocus(e, modal);
        });

        modal.addEventListener('click', (e) => {
            if (e.target === modal) this._closeDialog(modal);
        });

        const closeBtn = document.getElementById('closeAccountModal');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this._closeDialog(modal));
            closeBtn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this._closeDialog(modal);
                }
            });
        }

        document.getElementById('acctViewProfile').addEventListener('click', () => {
            this._closeDialog(modal);
            this.switchSection('profile');
        });
        document.getElementById('acctSettings').addEventListener('click', () => {
            this._closeDialog(modal);
            this.switchSection('settings');
        });
        document.getElementById('acctLogout').addEventListener('click', () => AuthAPI.logout());
    }

    openAccountDialog() {
        const modal = document.getElementById('accountModal');
        if (!modal) return;

        const eff = this.getEffectiveProfile();
        const name = eff.displayName || eff.username || 'User';
        const nameEl = document.getElementById('accountModalName');
        const roleEl = document.getElementById('accountModalRole');
        const avatarEl = document.getElementById('accountModalAvatar');

        if (nameEl) nameEl.textContent = name;
        if (roleEl) {
            const label = eff.role
                ? eff.role.charAt(0).toUpperCase() + eff.role.slice(1)
                : 'User';
            roleEl.textContent = label;
            roleEl.className = 'role-badge ' + (eff.role === 'admin' ? 'admin' : 'user');
        }
        if (avatarEl) {
            const initial = (name || 'U').charAt(0).toUpperCase();
            this._fillUserAvatarDisc(avatarEl, eff.avatar || avatarUrl(eff), eff.avatarEmoji, initial);
        }
        this._renderAccountInfoRows(eff);

        this._openDialog(modal);
    }

    _renderAccountInfoRows(eff) {
        const box = document.getElementById('accountInfoRows');
        if (!box) return;
        const dash = '<span class="profile-card-hint">Not set</span>';
        const rows = [
            ['Username', eff.username || dash],
            ['Email', eff.email || dash],
            ['Department', eff.department || dash],
            ['Phone', eff.phone || dash]
        ];
        box.innerHTML = rows.map(([label, value]) => `
            <div class="profile-row">
                <dt>${escapeHtml(label)}</dt>
                <dd class="${value === dash ? '' : 'is-strong'}">${value}</dd>
            </div>
        `).join('');
    }

    getEffectiveProfile() {
        const user = AuthAPI.getCurrentUser() || {};
        const local = this.getLocalProfile();
        return {
            displayName: local.displayName || user.username || user.email || '',
            username: user.username || local.username || '',
            email: local.email || user.email || '',
            role: local.role || user.role || '',
            phone: local.phone || '',
            department: local.department || user.department || '',
            // The locally-saved data URL wins for offline (O8). Server copy is
            // fallback. Check user.avatar_url from JWT which may have latest.
            avatar: local.avatar || avatarUrl(user) || '',
            avatarEmoji: user.avatar_emoji || local.avatarEmoji || ''
        };
    }

    _openDialog(modal, focusEl) {
        if (!modal) return;
        this._dialogOpener = document.activeElement;
        modal.style.display = 'block';
        const first = focusEl || modal.querySelector(
            'button:not([disabled]), [href], input:not([disabled]), select, textarea');
        if (first) first.focus();
    }

    _closeDialog(modal) {
        if (!modal) return;
        modal.style.display = 'none';
        if (this._dialogOpener && typeof this._dialogOpener.focus === 'function') {
            this._dialogOpener.focus();
        }
        this._dialogOpener = null;
    }

    _trapDialogFocus(e, modal) {
        if (e.key !== 'Tab' || !modal || modal.style.display === 'none') return;
        const focusable = Array.prototype.filter.call(
            modal.querySelectorAll(
                'button:not([disabled]), [href], input:not([disabled]), '
                + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'),
            el => el.offsetParent !== null);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
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
            // Publish the same resized picture to the server, which is what an
            // admin sees in the Assigned To column. The resized copy is sent
            // rather than the original so the server never stores a
            // multi-megabyte photo.
            this.syncAvatarToServer(dataUrl);
        });
    }

    // Push the locally-saved picture to the server so other users can see it.
    // A failure is reported but never discards the local copy: the picture is
    // still valid on this device, so the user is not left with nothing.
    async syncAvatarToServer(dataUrl) {
        const user = AuthAPI.getCurrentUser();
        if (!user || !user.id) return;
        try {
            const blob = await (await fetch(dataUrl)).blob();
            // resizeImage always produces JPEG, so name it accordingly: a Blob
            // appended with no filename arrives as "blob" with no extension.
            const updated = await uploadAvatar(user.id, blob, 'avatar.jpg');
            // A photo and an emoji are mutually exclusive, and the server has
            // just retired the emoji. Clear it locally too, or removing the
            // photo later would bring back an emoji the server no longer has.
            this.saveLocalProfile({ avatarPath: updated.avatar_url, avatarEmoji: '' });
        } catch (err) {
            this.showToast('Saved on this device, but not uploaded: '
                + (err.message || 'unknown error'), true);
        }
    }

    // Learn whether the account already has a server-side photo, so a device
    // that has never chosen one still shows it.
    async loadServerAvatar() {
        try {
            const response = await apiFetch(`${API_BASE_URL}/users/me`);
            if (!response.ok) return;
            const data = await response.json();
            if (!data) return;
            // The photo and the emoji are mutually exclusive server-side, so
            // only the one that is actually set is cached locally.
            const patch = {};
            if (data.avatar_url) patch.avatarPath = data.avatar_url;
            if (data.avatar_emoji) patch.avatarEmoji = data.avatar_emoji;
            if (Object.keys(patch).length) this.saveLocalProfile(patch);
        } catch (err) {
            // Offline or signed out. The monogram is the honest fallback.
        }
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

    // Set an emoji avatar, for a user with no picture to upload. Saved locally
    // first so it renders immediately and offline, then published to the
    // server so admins see it in the Assigned To column.
    async setEmojiAvatar(emoji) {
        this.saveLocalProfile({ avatarEmoji: emoji });
        this.refreshAvatarUI();
        this.renderIdentity();
        this.showToast('Emoji avatar set.');
        const user = AuthAPI.getCurrentUser();
        if (!user || !user.id) return;
        try {
            await setAvatarEmoji(user.id, emoji);
        } catch (err) {
            this.showToast('Set on this device, but not on the server: '
                + (err.message || 'unknown error'), true);
        }
    }

    async clearEmojiAvatar() {
        this.saveLocalProfile({ avatarEmoji: '' });
        this.refreshAvatarUI();
        this.renderIdentity();
        this.showToast('Emoji cleared.');
        const user = AuthAPI.getCurrentUser();
        if (!user || !user.id) return;
        try {
            await clearAvatarEmoji(user.id);
        } catch (err) {
            this.showToast('Cleared on this device, but not on the server: '
                + (err.message || 'unknown error'), true);
        }
    }

    // Re-draws the avatar everywhere it appears after a change. Every one of
    // the four picture actions mutates localStorage first and then calls this,
    // so the card, the sidebar preview and the ticket preview stay in step.
    refreshAvatarUI() {
        const eff = this.getEffectiveProfile();
        const initial = (eff.displayName || eff.username || 'U').charAt(0).toUpperCase();
        this._renderUserAvatarDiscs(eff, initial);
    }


    removeAvatar() {
        this.saveLocalProfile({ avatar: '' });
        this.refreshAvatarUI();
        this.renderIdentity();
        this.showToast('Profile picture removed.');
        // Also clear the server copy, or the picture an admin sees in the
        // Assigned To column would outlive the request to remove it.
        const user = AuthAPI.getCurrentUser();
        if (user && user.id) {
            deleteAvatar(user.id)
                .then((updated) => this.saveLocalProfile({ avatarPath: updated.avatar_url }))
                .catch((err) => this.showToast(
                    'Removed on this device, but not on the server: '
                    + (err.message || 'unknown error'), true));
        }
    }

    refreshUsernameGuard() {
        const usernameInput = document.getElementById('infoUsername');
        const guard = document.getElementById('usernameChangeGuard');
        if (!usernameInput || !guard) return;
        const saved = (AuthAPI.getCurrentUser() && AuthAPI.getCurrentUser().username) || '';
        const changed = usernameInput.value.trim() !== saved;
        guard.hidden = !changed;
    }



    // One save for the whole card. The username has its own password-guarded
    // endpoint, so it is sent first and aborts the rest if it fails. The three
    // contact fields go through PUT /api/users/me. The local copy is a cache
    // for offline rendering, not the save (O3, OFF3).
    async saveProfile() {
        const saveBtn = document.getElementById('saveProfileBtn');
        const msg = document.getElementById('profileSaveMsg');
        const savedUser = AuthAPI.getCurrentUser() || {};
        const usernameInput = document.getElementById('infoUsername');
        const newUsername = usernameInput ? usernameInput.value.trim() : '';

        const fail = (text) => {
            const msgText = document.getElementById('profileSaveMsgText');
            if (msgText) msgText.textContent = text.trim();
            if (msg) {
                msg.classList.add('is-error');
                msg.classList.add('is-visible');
                setTimeout(() => { msg.classList.remove('is-visible'); }, 4000);
            }
            if (saveBtn) saveBtn.disabled = false;
            this.showToast(text.trim(), true);
        };

        if (saveBtn) saveBtn.disabled = true;
        try {
            if (newUsername && savedUser.username && newUsername !== savedUser.username) {
                const passwordField = document.getElementById('profileCurrentPassword');
                const password = passwordField ? passwordField.value : '';
                if (!password) {
                    fail('Enter your current password to change your username.');
                    if (passwordField) passwordField.focus();
                    return;
                }
                await TicketAPI.changeUsername(newUsername, password);
            }

            await TicketAPI.updateMyProfile({
                display_name: document.getElementById('infoDisplayName').value.trim(),
                phone: document.getElementById('infoPhone').value.trim(),
                email: document.getElementById('infoEmail').value.trim()
            });
        } catch (err) {
            // Nothing is reported as saved that the server did not confirm (S2).
            const offline = !navigator.onLine;
            fail(offline
                ? 'Needs a connection. Your edits are still here.'
                : (err && err.message ? err.message : 'Could not save your profile.'));
            return;
        }

        this.saveLocalProfile({
            displayName: document.getElementById('infoDisplayName').value.trim(),
            email: document.getElementById('infoEmail').value.trim(),
            phone: document.getElementById('infoPhone').value.trim()
        });
        this.currentUser = AuthAPI.getCurrentUser();
        this.renderIdentity();
        this.renderWelcome();
        this._setUserProfileUnsaved(false);
        this._syncUserProfileIdentity();
        if (saveBtn) {
            saveBtn.classList.add('saved');
            saveBtn.textContent = 'Saved';
        }
        const okText = document.getElementById('profileSaveMsgText');
        if (okText) okText.textContent = 'Saved.';
        if (msg) {
            msg.classList.remove('is-error');
            msg.classList.add('is-visible');
        }
        setTimeout(() => {
            if (msg) msg.classList.remove('is-visible');
            if (saveBtn) {
                saveBtn.classList.remove('saved');
                saveBtn.textContent = 'Save Changes';
                saveBtn.disabled = false;
            }
        }, 1800);
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
            categories.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(this.capitalize(c.name))}</option>`).join('');

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
            await OfflineDB.enqueue('pending_tickets', payload, this.currentUser ? this.currentUser.username : '');
            await this.updatePendingBadge();
        } catch (error) {
            console.error('Failed to queue ticket offline:', error);
            this.showToast('Could not save offline. Please try again.', true);
        }
    }

    async enqueueComment(item) {
        try {
            await OfflineDB.enqueue('pending_comments', item, this.currentUser ? this.currentUser.username : '');
            await this.updatePendingBadge();
        } catch (error) {
            console.error('Failed to queue comment offline:', error);
            this.showToast('Could not save offline. Please try again.', true);
        }
    }

    async updatePendingBadge() {
        const badge = document.getElementById('pendingBadge');
        if (!badge) return;
        try {
            const user = this.currentUser ? this.currentUser.username : '';
            const [t, c] = await Promise.all([
                OfflineDB.getPending('pending_tickets', user),
                OfflineDB.getPending('pending_comments', user)
            ]);
            const all = t.concat(c);
            const failed = all.filter((i) => i.status === 'failed').length;
            const pending = all.length;
            if (pending === 0) {
                badge.style.display = 'none';
            } else {
                badge.style.display = 'inline-flex';
                badge.textContent = `${pending} pending submission${pending === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}`;
                badge.title = failed
                    ? `${failed} submission${failed === 1 ? '' : 's'} could not be sent and stay saved on this device.`
                    : '';
            }
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
            const user = this.currentUser ? this.currentUser.username : '';
            let tickets = [];
            let comments = [];
            try {
                [tickets, comments] = await Promise.all([
                    OfflineDB.getPending('pending_tickets', user),
                    OfflineDB.getPending('pending_comments', user)
                ]);
            } catch (error) {
                console.error('Could not read offline queue:', error);
                return;
            }
            // Merge both stores into one ordered list; skip items that hit the
            // hard retry cap (they stay inspectable in the badge).
            const queue = [
                ...tickets.map((item) => ({ kind: 'ticket', store: 'pending_tickets', item })),
                ...comments.map((item) => ({ kind: 'comment', store: 'pending_comments', item }))
            ].filter(({ item }) => (item.attempts || 0) < 5);
            if (queue.length === 0) return;

            // Fresh access token before replay. On failure (offline or a revoked
            // refresh token) every item stays queued and the user is told.
            try {
                await AuthAPI.refreshToken();
            } catch (refreshError) {
                AuthAPI.onSessionExpired();
                return;
            }

            let submitted = 0;
            let failed = 0;
            for (const { kind, store, item } of queue) {
                const result = kind === 'ticket'
                    ? await TicketAPI.createTicketOffline(item)
                    : await TicketAPI.createTicketCommentOffline(item.ticket_id, item.message, item.is_internal, item.client_uuid);
                if (result.ok) {
                    // 201 (new) or 200 (idempotent replay) both mean it's on the server.
                    await OfflineDB.remove(store, item.client_uuid);
                    submitted++;
                } else if (result.network) {
                    // Network dropped again mid-flush — leave this one queued.
                    continue;
                } else {
                    // 4xx/5xx: the server rejected this payload on its merits.
                    // Mark it failed in place — never silently delete (S7) — so the
                    // badge can surface the count and the item stays inspectable.
                    const attempts = (item.attempts || 0) + 1;
                    await OfflineDB.patch(store, item.client_uuid, {
                        attempts: attempts,
                        status: 'failed',
                        last_error: (result.error && result.error.message) || `HTTP ${result.status}`
                    });
                    failed++;
                }
            }

            await this.updatePendingBadge();
            if (submitted > 0 || failed > 0) {
                this.refreshTicketCache();
                if (submitted > 0) {
                    this.markSynced();
                    await this.loadTickets();
                    this.renderPersonalDashboard();
                    this.showToast(`${submitted} offline submission${submitted === 1 ? '' : 's'} submitted.`);
                    // IDLE — costs money when enabled (paid push provider).
                    this.maybePushNotify({ type: 'offline_tickets_submitted', count: submitted });
                }
                if (failed > 0) {
                    this.showToast(`${failed} offline submission${failed === 1 ? '' : 's'} could not be sent. They stay saved on this device.`, true);
                }
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

// ============ Sidebar (YouTube-style three states, persistent) ============
// Sidebar states (YouTube-style three-state behaviour):
//   Expanded (full) <-> Mini (icon rail) on wide screens (>1024px).
//   The 769-1024px band is Mini-fixed; the hamburger opens Expanded as an
// SidebarManager is loaded from shared/js/sidebar.js

let app;
document.addEventListener('DOMContentLoaded', () => {
    Icons.hydrate();
    SidebarManager.init();
    app = new TicketingApp();
});
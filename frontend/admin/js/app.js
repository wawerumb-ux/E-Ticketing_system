 // Admin Portal Application Logic
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
const SECTION_TITLES = {
    dashboard: 'Dashboard',
    tickets: 'All Tickets',
    create: 'Create Ticket',
    users: 'User Management',
    reports: 'Reports',
    knowledge: 'Knowledge Base',
    announcements: 'Announcements',
    integrations: 'Integrations',
    settings: 'Settings',
    audit: 'Audit Log'
};
class TicketingApp {
    constructor() {
        AuthAPI.requireAuth();
        this.currentSection = 'dashboard';
        this.tickets = [];
        this.filteredTickets = [];
        this.users = [];
        this.filteredUsers = [];
        this.usersLoadError = false;
        this.activeQueue = 'all';
        this.sortField = 'created_at';
        this.sortDirection = 'desc';
        this.sortExplicit = false;
        this.selectedTicketIds = new Set();
        this.auditShowDetails = false;
        this.activeTicketAttachments = [];
        this.identityMenuOpen = false;
        this.identityMenuFindActive = false;
        this.syncing = false;
        this.init();
    }

    async init() {
        this.applyTheme();
        this.loadNotificationPrefs();
        this.renderIdentity();
        this.setupOfflineSync();
        window.showToast = (message, type) => this.showToast(message, type === 'error');
        this.setupIdentityMenu();
        this.setupProfileModal();
        this.setupChangePasswordModal();
        this.setupEventListeners();
        await this.loadUsers();
        await this.loadTickets();
        // Dashboard loads through the section router (renderSection), so a
        // reload on a deep hash (#/users, #/audit, ...) does not fetch stats
        // the user is not looking at. initSectionRouting renders once here.
        this.setupLiveEvents();
        this.initSessionExpiredDialog();
        this.initSectionRouting();
    }

    // ============ Offline (shared engine: OfflineDB + origin-wide SW) ============
    _offlineUser() {
        const u = AuthAPI.getCurrentUser();
        return u ? u.username : '';
    }

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
            await OfflineDB.enqueue('pending_tickets', payload, this._offlineUser());
            await this.updatePendingBadge();
        } catch (error) {
            console.error('Failed to queue ticket offline:', error);
            this.showToast('Could not save offline. Please try again.', true);
        }
    }

    async enqueueComment(item) {
        try {
            await OfflineDB.enqueue('pending_comments', item, this._offlineUser());
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
            const [t, c] = await Promise.all([
                OfflineDB.getPending('pending_tickets', this._offlineUser()),
                OfflineDB.getPending('pending_comments', this._offlineUser())
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

    _formatClock(date) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    // Only called on a genuine server round-trip (never on cache-served data).
    markSynced() {
        const el = document.getElementById('lastSynced');
        if (el) el.textContent = `last synced: ${this._formatClock(new Date())}`;
    }

    // Ask the SW to evict cached data lists after a successful flush so the
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
            const user = this._offlineUser();
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
                    if (this.currentSection === 'dashboard') this.loadDashboard();
                    this.showToast(`${submitted} offline submission${submitted === 1 ? '' : 's'} submitted.`);
                }
                if (failed > 0) {
                    this.showToast(`${failed} offline submission${failed === 1 ? '' : 's'} could not be sent. They stay saved on this device.`, true);
                }
            }
        } finally {
            this.syncing = false;
        }
    }

    // Honest "requires connection" state: never a silent empty table.
    renderOfflineTicketsEmptyState() {
        this.renderQueueCounts();
        const tbody = document.getElementById('ticketTableBody');
        if (!tbody) return;
        tbody.innerHTML = `
            <tr>
                <td colspan="10">
                    <div class="empty-state">
                        ${Icons.render('wifi')}
                        <p>Requires connection to load tickets.</p>
                        <p style="color:var(--text-muted,#888888);font-size:0.85rem;">Reconnect to see the queue.</p>
                    </div>
                </td>
            </tr>
        `;
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
        LiveEvents.on('attachment.created', reloadTickets);
        LiveEvents.on('announcement', () => this.showToast('New announcement received.'));
    }

    setupEventListeners() {
        document.querySelectorAll('.sidebar-nav li').forEach(item => {
            item.addEventListener('click', () => this.switchSection(item.dataset.section));
        });

        this.initThemePicker();

        document.getElementById('ticketForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleTicketSubmit(e);
        });

        document.getElementById('userForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleUserSubmit(e);
        });

        document.getElementById('statusFilter').addEventListener('change', () => this.filterTickets());
        document.getElementById('priorityFilter').addEventListener('change', () => this.filterTickets());
        document.getElementById('searchTicket').addEventListener('input', () => this.filterTickets());
        document.querySelectorAll('#tickets th[data-sort]').forEach(th => {
            th.addEventListener('click', () => this.handleSort(th.dataset.sort));
        });
        document.getElementById('searchUser').addEventListener('input', () => this.renderUsers());
        document.getElementById('userRoleFilter').addEventListener('change', () => this.renderUsers());
        document.getElementById('userStatusFilter').addEventListener('change', () => this.renderUsers());
        document.getElementById('userDepartmentFilter').addEventListener('change', () => this.renderUsers());
        document.getElementById('auditEntityFilter').addEventListener('change', () => this.loadAuditLogs());

        document.querySelectorAll('.queue-chip').forEach(chip => {
            chip.addEventListener('click', () => this.setActiveQueue(chip.dataset.queue));
        });

        // Dashboard drill-down: click a stat card, land on Tickets filtered to that status
        document.querySelectorAll('.stat-card[data-drill]').forEach(card => {
            card.addEventListener('click', () => {
                const drill = card.dataset.drill;
                const queueMap = { all: 'all', open: 'all', in_progress: 'in_progress', resolved: 'recently_resolved', sla_response: 'sla_response', sla_resolution: 'sla_resolution' };
                this.setActiveQueue(queueMap[drill] || 'all');
                if (drill === 'open') {
                    document.getElementById('statusFilter').value = 'open';
                } else {
                    document.getElementById('statusFilter').value = 'all';
                }
                this.switchSection('tickets');
                this.filterTickets();
            });
        });

        document.querySelector('#userModal .close').addEventListener('click', () => {
            document.getElementById('userModal').style.display = 'none';
        });

        document.getElementById('showAddUserModal').addEventListener('click', () => {
            document.getElementById('userModal').style.display = 'block';
        });

        document.querySelector('#ticketWorkspaceModal .close').addEventListener('click', () => {
            document.getElementById('ticketWorkspaceModal').style.display = 'none';
        });

        document.getElementById('ticketWorkspaceForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleWorkspaceSave();
        });

        document.getElementById('workspaceDeleteBtn').addEventListener('click', () => {
            this.deleteTicket(this.activeTicketId);
        });

        document.getElementById('workspaceAttachmentForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleWorkspaceAttachmentSubmit();
        });

        document.getElementById('closeEditUserModal').addEventListener('click', () => {
            document.getElementById('editUserModal').style.display = 'none';
        });

        document.getElementById('editUserForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleEditUserSubmit();
        });

        // Phase 3: link a phone number to the user being edited so USSD callers
        // are recognised by their real username (and see their own tickets).
        document.getElementById('linkPhoneBtn').addEventListener('click', () => {
            this.handleLinkPhone();
        });

        document.getElementById('closeUserDetailModal').addEventListener('click', () => {
            document.getElementById('userDetailModal').style.display = 'none';
        });

        document.getElementById('userDetailEditBtn').addEventListener('click', () => {
            document.getElementById('userDetailModal').style.display = 'none';
            this.openEditUserModal(this.activeDetailUserId);
        });

        document.getElementById('userDetailReset2faBtn').addEventListener('click', async () => {
            await this.resetUser2fa();
        });

        document.getElementById('userDetailToggleActiveBtn').addEventListener('click', async () => {
            const user = this.users.find(u => u.id === this.activeDetailUserId);
            if (!user) return;
            if (user.is_active === false) {
                await this.reactivateUser(user.id);
            } else {
                await this.deleteUser(user.id);
            }
            document.getElementById('userDetailModal').style.display = 'none';
        });

        // Note templates: selecting one prefills the reply box, doesn't send it
        document.getElementById('noteTemplateSelect').addEventListener('change', (e) => {
            if (e.target.value) {
                document.getElementById('workspaceCommentInput').value = e.target.value;
                e.target.value = '';
            }
        });

        document.getElementById('workspaceCommentForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleWorkspaceCommentSubmit();
        });

        // Ticket Detail Popup
        document.getElementById('closeTicketDetail').addEventListener('click', () => {
            document.getElementById('ticketDetailModal').style.display = 'none';
        });
        window.addEventListener('click', (e) => {
            if (e.target === document.getElementById('ticketDetailModal')) {
                document.getElementById('ticketDetailModal').style.display = 'none';
            }
        });

        // Bulk actions
        document.getElementById('selectAllTickets').addEventListener('change', (e) => {
            this.toggleSelectAll(e.target.checked);
        });

        document.getElementById('bulkClearBtn').addEventListener('click', () => this.clearSelection());
        document.getElementById('bulkApplyBtn').addEventListener('click', () => this.applyBulkAction());

        window.addEventListener('click', (e) => {
            if (e.target === document.getElementById('userModal')) {
                document.getElementById('userModal').style.display = 'none';
            }
            if (e.target === document.getElementById('ticketWorkspaceModal')) {
                document.getElementById('ticketWorkspaceModal').style.display = 'none';
            }
            if (e.target === document.getElementById('editUserModal')) {
                document.getElementById('editUserModal').style.display = 'none';
            }
        });

        document.getElementById('logoutBtn').addEventListener('click', () => AuthAPI.logout());

        document.getElementById('addCategoryForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleAddCategory();
        });

        document.getElementById('addDepartmentForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleAddDepartment();
        });

        document.getElementById('addRoleForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleAddRole();
        });

        // ============ Phase 3 listeners ============
        document.getElementById('runReportBtn').addEventListener('click', () => this.loadReports());
        document.getElementById('exportTicketsBtn').addEventListener('click', () => this.exportReport('tickets'));
        document.getElementById('exportUsersBtn').addEventListener('click', () => this.exportReport('users'));
        document.getElementById('exportAuditBtn').addEventListener('click', () => this.exportReport('audit'));

        document.getElementById('newArticleBtn').addEventListener('click', () => this.openNewKBArticle());
        document.getElementById('closeKbModal').addEventListener('click', () => {
            document.getElementById('kbModal').style.display = 'none';
        });
        document.getElementById('kbForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.saveKBArticle();
        });
        document.getElementById('kbSearch').addEventListener('input', () => this.loadKnowledgeArticles());
        document.getElementById('kbCategoryFilter').addEventListener('change', () => this.loadKnowledgeArticles());

        window.addEventListener('click', (e) => {
            if (e.target === document.getElementById('kbModal')) {
                document.getElementById('kbModal').style.display = 'none';
            }
        });

        document.getElementById('broadcastForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.sendBroadcast();
        });

        document.getElementById('systemSettingsForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.saveSystemSettings();
        });

        // ============ Phase 4 listeners ============
        document.getElementById('tokenForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.createToken();
        });
        document.getElementById('webhookForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.createWebhook();
        });
        document.getElementById('reset2faBtn').addEventListener('click', async () => {
            const sel = document.getElementById('reset2faUser');
            const uid = sel ? sel.value : '';
            if (!uid) { this.showToast('Select a user first.', true); return; }
            try {
                await TicketAPI.resetUser2FA(uid);
                this.showToast('Two-factor authentication cleared for that user.');
            } catch (error) {
                this.showToast(error.message, true);
            }
        });
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
        localStorage.setItem('admin_theme', id);
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
        const saved = localStorage.getItem('admin_theme') || 'light';
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

    loadNotificationPrefs() {
        const container = document.getElementById('notificationPrefs');
        if (!container) return;
        if (typeof window.NotificationPrefs === 'undefined') {
            container.innerHTML = '<div class="pref-offline"><strong>Not available</strong><p>Notification preferences could not be loaded right now.</p></div>';
            return;
        }
        window.NotificationPrefs.render(container);
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

    // ============ Sidebar identity (avatar monogram + name + role) ============
    renderIdentity() {
        const user = AuthAPI.getCurrentUser();
        const nameEl = document.getElementById('sidebarUserName');
        const roleEl = document.getElementById('sidebarUserRole');
        const avatarEl = document.getElementById('sidebarAvatar');
        if (!user) return;
        const eff = this.getEffectiveProfile();
        const name = eff.displayName || eff.username || 'Admin';
        if (nameEl) { nameEl.textContent = name; nameEl.title = name; }
        if (roleEl) {
            const roleLabel = eff.role
                ? eff.role.charAt(0).toUpperCase() + eff.role.slice(1)
                : 'Administrator';
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

    // ============ Admin identity menu (account + user-management launcher) ============
    // Superset of the user portal's identity block: same avatars/name/role slots,
    // extended with inline account + user-management actions. Offline-first: all
    // items are either routes/modals that already exist client-side, or are
    // disabled with a visible TODO (no invented backend endpoints).
    setupIdentityMenu() {
        const launcher = document.getElementById('identityLauncher');
        const menu = document.getElementById('identityMenu');
        if (!launcher || !menu) return;

        // Snapshot the static markup once; the "Find user" panel swaps the menu
        // body and the Back button restores this snapshot.
        this.identityMenuHtml = menu.innerHTML;

        menu.addEventListener('keydown', (e) => this.handleIdentityMenuKeydown(e));

        launcher.addEventListener('click', () => this.toggleIdentityMenu());
        launcher.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.toggleIdentityMenu();
            }
        });

        // Mini-state flyout: reveal on hover, dismiss on leave (keyboard path
        // still uses click / Enter / Space / Escape).
        launcher.addEventListener('mouseenter', () => {
            if (document.documentElement.classList.contains('sidebar-mini')) this.openIdentityMenu();
        });
        menu.addEventListener('mouseleave', () => {
            if (document.documentElement.classList.contains('sidebar-mini') && document.activeElement === launcher) {
                this.closeIdentityMenu(false);
            }
        });

        this.rebindIdentityMenuItems();

        document.addEventListener('pointerdown', (e) => {
            if (!this.identityMenuOpen) return;
            if (launcher.contains(e.target) || menu.contains(e.target)) return;
            this.closeIdentityMenu(false);
        });
    }

    // TODO: "View profile" (own profile route) and "Change password"
    // (password-change modal) have no backend route yet — keep them disabled.
    // ============ Admin profile helpers (localStorage-backed, separate from user portal) ============
    getLocalProfile() {
        try {
            const raw = localStorage.getItem('admin_profile');
            if (raw) return JSON.parse(raw) || {};
        } catch (e) { /* fall through */ }
        return {};
    }

    saveLocalProfile(patch) {
        try {
            const profile = Object.assign({}, this.getLocalProfile(), patch);
            localStorage.setItem('admin_profile', JSON.stringify(profile));
            return profile;
        } catch (e) {
            this.showToast('Could not save profile locally.', true);
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
            role: local.role || user.role || '',
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

    toggleIdentityMenu() {
        if (this.identityMenuOpen) this.closeIdentityMenu(true);
        else this.openIdentityMenu();
    }

    openIdentityMenu() {
        const menu = document.getElementById('identityMenu');
        const launcher = document.getElementById('identityLauncher');
        if (!menu || !launcher || this.identityMenuOpen) return;
        this.identityMenuOpen = true;
        if (this.identityMenuFindActive) this.restoreIdentityMenu();
        menu.hidden = false;
        menu.classList.add('open');
        this.positionIdentityMenu();
        launcher.classList.add('open');
        launcher.setAttribute('aria-expanded', 'true');
        this.focusFirstIdentityItem();
    }

    closeIdentityMenu(returnFocus) {
        const menu = document.getElementById('identityMenu');
        const launcher = document.getElementById('identityLauncher');
        if (!menu || !launcher || !this.identityMenuOpen) return;
        this.identityMenuOpen = false;
        menu.classList.remove('open');
        menu.hidden = true;
        launcher.classList.remove('open');
        launcher.setAttribute('aria-expanded', 'false');
        if (this.identityMenuFindActive) this.restoreIdentityMenu();
        if (returnFocus && typeof launcher.focus === 'function') launcher.focus();
    }

    positionIdentityMenu() {
        const menu = document.getElementById('identityMenu');
        const launcher = document.getElementById('identityLauncher');
        if (!menu || !launcher) return;
        const mini = document.documentElement.classList.contains('sidebar-mini');
        const r = launcher.getBoundingClientRect();
        const maxLeft = Math.max(8, window.innerWidth - menu.offsetWidth - 8);
        menu.style.left = '';
        menu.style.top = '';
        menu.style.left = Math.min(Math.max(8, mini ? r.right + 10 : r.left), maxLeft) + 'px';
        let top = r.top - menu.offsetHeight - 8;
        if (top < 8) top = r.bottom + 8;
        if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top + 8);
        menu.style.top = top + 'px';
    }

    focusFirstIdentityItem() {
        const items = this.getFocusableMenuItems();
        if (items.length > 0) items[0].focus();
    }

    getFocusableMenuItems() {
        const menu = document.getElementById('identityMenu');
        if (!menu) return [];
        return Array.prototype.slice.call(
            menu.querySelectorAll('.identity-menu-item:not([aria-disabled="true"])')
        );
    }

    handleIdentityMenuKeydown(e) {
        const items = this.getFocusableMenuItems();
        if (items.length === 0) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const delta = e.key === 'ArrowDown' ? 1 : -1;
            const current = items.indexOf(document.activeElement);
            items[(current + delta + items.length) % items.length].focus();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            if (this.identityMenuFindActive) this.restoreIdentityMenu(true);
            else this.closeIdentityMenu(true);
        }
    }

    rebindIdentityMenuItems() {
        document.getElementById('menuViewProfile').addEventListener('click', () => {
            this.closeIdentityMenu(false);
            this.openProfileModal();
        });
        document.getElementById('menuChangePassword').addEventListener('click', () => {
            this.closeIdentityMenu(false);
            this.openChangePasswordModal();
        });
        document.getElementById('menuTheme').addEventListener('click', () => {
            this.closeIdentityMenu(false);
            this.switchSection('settings');
        });
        document.getElementById('menuFindUser').addEventListener('click', () => this.openFindUserPanel());
        document.getElementById('menuAddUser').addEventListener('click', () => {
            this.closeIdentityMenu(false);
            const btn = document.getElementById('showAddUserModal');
            if (btn) btn.click();
        });
        document.getElementById('menuBulk').addEventListener('click', () => {
            this.closeIdentityMenu(false);
            this.switchSection('tickets');
        });
        document.getElementById('menuLogout').addEventListener('click', () => AuthAPI.logout());
    }

    // "Find user": searches this.users (already cached in memory from the Users
    // page load). Offline with no cache, it shows an honest message instead of
    // a broken panel. No backend call is made here.
    openFindUserPanel() {
        const menu = document.getElementById('identityMenu');
        if (!menu) return;
        this.identityMenuFindActive = true;
        const hasUsers = Array.isArray(this.users) && this.users.length > 0;
        menu.innerHTML = `
            <div class="identity-menu-find">
                <div class="identity-menu-find-head">
                    <button type="button" class="identity-menu-back" id="findUserBack" aria-label="Back to account menu">${Icons.render('chevron-left')}</button>
                    <span>Find user</span>
                </div>
                <div class="identity-menu-search">
                    ${Icons.render('search')}
                    <input id="findUserInput" type="search" placeholder="Username or email" autocomplete="off">
                </div>
                <div id="findUserResults" class="identity-menu-results" role="listbox" aria-label="Matching users">
                    ${hasUsers ? '' : '<p class="identity-menu-hint">User lookup requires a connection. Users load automatically once you are back online.</p>'}
                </div>
            </div>
        `;
        this.positionIdentityMenu();
        const input = document.getElementById('findUserInput');
        if (input) input.focus();
        document.getElementById('findUserBack').addEventListener('click', () => this.restoreIdentityMenu(true));
        input.addEventListener('input', () => this.renderFindUserResults(input.value));
        this.renderFindUserResults('');
    }

    restoreIdentityMenu(returnFocusToFind) {
        const menu = document.getElementById('identityMenu');
        if (!menu) return;
        this.identityMenuFindActive = false;
        menu.innerHTML = this.identityMenuHtml;
        this.rebindIdentityMenuItems();
        this.positionIdentityMenu();
        if (returnFocusToFind) {
            const find = document.getElementById('menuFindUser');
            if (find) find.focus();
        }
    }

    renderFindUserResults(query) {
        const container = document.getElementById('findUserResults');
        if (!container) return;
        const users = Array.isArray(this.users) ? this.users : [];
        if (users.length === 0) return; // offline hint already rendered
        const q = (query || '').trim().toLowerCase();
        const matches = q
            ? users.filter((u) =>
                (u.username || '').toLowerCase().includes(q) ||
                (u.email || '').toLowerCase().includes(q))
            : users;
        const list = matches.slice(0, 8);
        container.innerHTML = list.map((u) => `
            <button type="button" class="identity-menu-item identity-menu-user" role="option" onclick="app.jumpToUser(${u.id})">
                <span class="mu-name" title="${this._esc(u.username || '')}">${this._esc(u.username) || '—'}</span>
                <span class="mu-detail">${this._esc(u.email || '')}${u.department ? ' · ' + this._esc(u.department) : ''}</span>
            </button>
        `).join('') || '<p class="identity-menu-hint">No matching users.</p>';
    }

    jumpToUser(id) {
        this.closeIdentityMenu(false);
        this.openEditUserModal(id);
    }

    // ============ Admin profile modal (View profile) ============
    async openProfileModal() {
        const modal = document.getElementById('profileModal');
        if (!modal) return;

        const serverProfile = await TicketAPI.getMyProfile();
        const user = AuthAPI.getCurrentUser() || {};
        const eff = this.getEffectiveProfile(serverProfile || user);
        const initial = (eff.displayName || eff.username || 'A').charAt(0).toUpperCase();

        document.getElementById('adminProfileDisplayName').value = eff.displayName || '';
        document.getElementById('adminProfilePhone').value = eff.phone || '';
        document.getElementById('adminProfileEmail').value = eff.email || '';
        document.getElementById('adminProfileUsername').value = eff.username || user.username || '';
        document.getElementById('adminProfileRole').value = (eff.role || user.role || 'admin').charAt(0).toUpperCase() + (eff.role || user.role || 'admin').slice(1);

        const preview = document.getElementById('adminProfileAvatarPreview');
        if (preview) preview.innerHTML = eff.avatar
            ? '<img src="' + eff.avatar + '" alt="" style="width:100%;height:100%;object-fit:cover;">'
            : initial;
        document.getElementById('adminRemoveAvatarBtn').style.display = eff.avatar ? 'block' : 'none';

        this.populateDepartmentSelects().then(() => {
            const sel = document.getElementById('adminProfileDepartment');
            if (sel && eff.department) sel.value = eff.department;
        });

        modal.style.display = 'block';
    }

    setupProfileModal() {
        document.getElementById('adminUploadAvatarBtn').addEventListener('click', () => {
            document.getElementById('adminAvatarFileInput').click();
        });
        document.getElementById('adminAvatarFileInput').addEventListener('change', (e) => {
            this.handleAdminAvatarFile(e.target.files && e.target.files[0]);
            e.target.value = '';
        });
        document.getElementById('adminRemoveAvatarBtn').addEventListener('click', () => this.removeAdminAvatar());
        document.getElementById('adminSaveProfileBtn').addEventListener('click', () => this.saveAdminProfile());
        document.getElementById('closeProfileModal').addEventListener('click', () => {
            document.getElementById('profileModal').style.display = 'none';
        });
    }

    handleAdminAvatarFile(file) {
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
            this.refreshAdminAvatarUI();
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

    refreshAdminAvatarUI() {
        const local = this.getLocalProfile();
        const preview = document.getElementById('adminProfileAvatarPreview');
        const removeBtn = document.getElementById('adminRemoveAvatarBtn');
        const user = AuthAPI.getCurrentUser() || {};
        const name = local.displayName || user.username || 'Admin';
        if (preview) {
            preview.innerHTML = local.avatar
                ? '<img src="' + local.avatar + '" alt="" style="width:100%;height:100%;object-fit:cover;">'
                : name.charAt(0).toUpperCase();
        }
        if (removeBtn) removeBtn.style.display = local.avatar ? 'block' : 'none';
    }

    removeAdminAvatar() {
        this.saveLocalProfile({ avatar: '' });
        this.refreshAdminAvatarUI();
        this.renderIdentity();
        this.showToast('Profile picture removed.');
    }

    saveAdminProfile() {
        this.saveLocalProfile({
            displayName: document.getElementById('adminProfileDisplayName').value.trim(),
            phone: document.getElementById('adminProfilePhone').value.trim(),
            department: document.getElementById('adminProfileDepartment').value,
            email: document.getElementById('adminProfileEmail').value.trim()
        });
        this.renderIdentity();
        const msg = document.getElementById('adminProfileSaveMsg');
        if (msg) {
            msg.style.display = 'inline';
            setTimeout(() => { msg.style.display = 'none'; }, 2500);
        }
    }

    // ============ Change password modal ============
    openChangePasswordModal() {
        const modal = document.getElementById('changePasswordModal');
        if (!modal) return;
        document.getElementById('changePasswordForm').reset();
        modal.style.display = 'block';
    }

    setupChangePasswordModal() {
        document.getElementById('changePasswordForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleChangePassword();
        });
        document.getElementById('closeChangePasswordModal').addEventListener('click', () => {
            document.getElementById('changePasswordModal').style.display = 'none';
        });
    }

    async handleChangePassword() {
        const current = document.getElementById('adminCurrentPassword').value;
        const pw = document.getElementById('adminNewPassword').value;
        const confirm = document.getElementById('adminConfirmPassword').value;

        if (!current || !pw || !confirm) {
            this.showToast('All fields are required.', true);
            return;
        }
        if (pw !== confirm) {
            this.showToast('New password and confirmation do not match.', true);
            return;
        }
        if (pw.length < 8) {
            this.showToast('New password must be at least 8 characters.', true);
            return;
        }

        try {
            await TicketAPI.changePassword(current, pw);
            this.showToast('Password updated successfully!');
            document.getElementById('changePasswordModal').style.display = 'none';
            document.getElementById('changePasswordForm').reset();
        } catch (error) {
            this.showToast(error.message, true);
        }
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
        this.renderSection(this.getCurrentHash() || 'dashboard');
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
            history.replaceState(null, '', '#/dashboard');
            this.renderSection('dashboard');
        }
    }

    renderSection(sectionId) {
        if (!SECTION_TITLES[sectionId]) sectionId = 'dashboard';
        document.querySelectorAll('.sidebar-nav li').forEach(item => {
            const isActive = item.dataset.section === sectionId;
            item.classList.toggle('active', isActive);
            // Phase 6 converts the items to <a href="#/...">; until then keep
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

        if (sectionId === 'dashboard') this.loadDashboard();
        if (sectionId === 'tickets') this.filterTickets();
        if (sectionId === 'create') this.populateAssignedToSelect();
        if (sectionId === 'users') {
            this.populateDepartmentSelects();
            this.loadRoles().then(() => this.loadUsers()).then(() => this.renderUsers());
        }
        if (sectionId === 'reports') this.loadReports();
        if (sectionId === 'knowledge') {
            this.populateKBCategories();
            this.loadKnowledgeArticles();
        }
        if (sectionId === 'settings') this.loadSettings();
        if (sectionId === 'integrations') this.loadIntegrations();
        if (sectionId === 'audit') this.loadAuditLogs();
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

    async loadDashboard() {
        try {
            const stats = await TicketAPI.getDashboardStats();
            if (stats) {
                document.getElementById('totalTickets').textContent = stats.total || 0;
                document.getElementById('openTickets').textContent = stats.open || 0;
                document.getElementById('inProgressTickets').textContent = stats.in_progress || 0;
                document.getElementById('resolvedTickets').textContent = stats.resolved || 0;

                const maxPriority = Math.max(stats.priority_breakdown.high || 0,
                                           stats.priority_breakdown.medium || 0,
                                           stats.priority_breakdown.low || 0) || 1;

                document.getElementById('highBar').style.width =
                    `${((stats.priority_breakdown.high || 0) / maxPriority) * 100}%`;
                document.getElementById('mediumBar').style.width =
                    `${((stats.priority_breakdown.medium || 0) / maxPriority) * 100}%`;
                document.getElementById('lowBar').style.width =
                    `${((stats.priority_breakdown.low || 0) / maxPriority) * 100}%`;

                document.getElementById('highCount').textContent = stats.priority_breakdown.high || 0;
                document.getElementById('mediumCount').textContent = stats.priority_breakdown.medium || 0;
                document.getElementById('lowCount').textContent = stats.priority_breakdown.low || 0;

                const sla = stats.sla || {};
                document.getElementById('slaResponseBreached').textContent = sla.response_breached || 0;
                document.getElementById('slaResolutionBreached').textContent = sla.resolution_breached || 0;
            }
        } catch (error) {
            console.error('Error loading dashboard:', error);
        }
        this.renderWorkloadWidget();
    }

    // ============ Technician Workload ============
    // Computed entirely client-side from tickets + users already loaded — no new backend.
    renderWorkloadWidget() {
        const container = document.getElementById('workloadList');
        if (!container) return;

        const technicians = this.users.filter(u => u.is_active !== false);
        if (technicians.length === 0) {
            container.innerHTML = '<p style="color:#999;">No technicians found.</p>';
            return;
        }

        const workload = technicians.map(tech => {
            const openCount = this.tickets.filter(t => t.assigned_to === tech.username && t.status !== 'resolved').length;
            return { username: tech.username, count: openCount };
        }).sort((a, b) => b.count - a.count);

        const maxCount = Math.max(...workload.map(w => w.count), 1);

        container.innerHTML = workload.map(w => {
            const pct = (w.count / maxCount) * 100;
            const level = w.count >= 8 ? 'high' : w.count >= 4 ? 'medium' : 'low';
            return `
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;">
                    <span style="min-width:100px;font-size:0.9rem;">${this._esc(w.username)}</span>
                    <div class="bar-container" style="flex:1;">
                        <div class="bar workload-bar-${level}" style="width:${pct}%;"></div>
                    </div>
                    <span style="min-width:20px;text-align:right;font-weight:500;">${w.count}</span>
                </div>
            `;
        }).join('');
    }

    async loadTickets() {
        try {
            const meta = await TicketAPI.getTicketsWithMeta();
            if (!meta.ok) {
                // Network failure with nothing cached (or a server error) — show
                // an honest "requires connection" state, never a silent empty table.
                this.tickets = [];
                this.filteredTickets = [];
                this.renderOfflineTicketsEmptyState();
                return;
            }
            this.tickets = meta.tickets;
            // "last synced" is stamped only on a genuine server round-trip,
            // never on a cache hit (X-ICT-Cache: hit).
            if (!meta.fromCache) this.markSynced();
            this.filterTickets();
        } catch (error) {
            console.error('Error loading tickets:', error);
            this.renderOfflineTicketsEmptyState();
        }
    }

    // ============ Queues ============
    // Filtered client-side from the fields every ticket already carries
    // (status, priority, and the live-computed sla_response_breached /
    // sla_resolution_breached booleans).
    setActiveQueue(queue) {
        this.activeQueue = queue;
        document.querySelectorAll('.queue-chip').forEach(chip => {
            chip.classList.toggle('active', chip.dataset.queue === queue);
        });
        this.filterTickets();
    }

    applyQueueFilter(tickets) {
        switch (this.activeQueue) {
            case 'unassigned':
                return tickets.filter(t => !t.assigned_to);
            case 'high_priority':
                return tickets.filter(t => t.priority === 'high' && t.status !== 'resolved');
            case 'in_progress':
                return tickets.filter(t => t.status === 'in_progress');
            case 'recently_resolved':
                return [...tickets.filter(t => t.status === 'resolved')]
                    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
            case 'sla_response':
                return tickets.filter(t => t.sla_response_breached);
            case 'sla_resolution':
                return tickets.filter(t => t.sla_resolution_breached);
            default:
                return tickets;
        }
    }

    filterTickets() {
        const statusFilter = document.getElementById('statusFilter').value;
        const priorityFilter = document.getElementById('priorityFilter').value;
        const searchQuery = document.getElementById('searchTicket').value.toLowerCase();

        let filtered = this.applyQueueFilter(this.tickets);

        if (statusFilter !== 'all') filtered = filtered.filter(t => t.status === statusFilter);
        if (priorityFilter !== 'all') filtered = filtered.filter(t => t.priority === priorityFilter);
        if (searchQuery) {
            filtered = filtered.filter(t =>
                t.title.toLowerCase().includes(searchQuery) ||
                t.ticket_number.toLowerCase().includes(searchQuery) ||
                t.description.toLowerCase().includes(searchQuery)
            );
        }

        // Order is only re-sorted once the user actively picks a column. Before
        // that, the queue's own intended order (e.g. recently_resolved sorts by
        // updated_at) stays untouched — same default behaviour as before.
        this.filteredTickets = this.sortExplicit ? this.sortTickets(filtered) : filtered;
        this.renderQueueCounts();
        this.renderTickets(this.filteredTickets);
        this.updateSortIndicators();
    }

    // Same sort contract as the user portal: string/date fields on the ticket,
    // toggled on repeat clicks, never mutating the source array in place.
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
        this.sortExplicit = true;
        this.filterTickets();
    }

    updateSortIndicators() {
        document.querySelectorAll('#tickets th[data-sort]').forEach(th => {
            th.classList.remove('sorted-asc', 'sorted-desc');
            // Only the user-chosen column is marked; before an explicit sort
            // the table shows the queue's natural order (no active indicator).
            if (this.sortExplicit && th.dataset.sort === this.sortField) {
                th.classList.add(this.sortDirection === 'asc' ? 'sorted-asc' : 'sorted-desc');
            }
        });
    }

    renderQueueCounts() {
        const counts = {
            all: this.tickets.length,
            unassigned: this.tickets.filter(t => !t.assigned_to).length,
            high_priority: this.tickets.filter(t => t.priority === 'high' && t.status !== 'resolved').length,
            in_progress: this.tickets.filter(t => t.status === 'in_progress').length,
            recently_resolved: this.tickets.filter(t => t.status === 'resolved').length,
            sla_response: this.tickets.filter(t => t.sla_response_breached).length,
            sla_resolution: this.tickets.filter(t => t.sla_resolution_breached).length
        };
        Object.keys(counts).forEach(key => {
            const el = document.getElementById(`queueCount_${key}`);
            if (el) el.textContent = counts[key];
        });
    }

    renderTickets(tickets) {
        const tbody = document.getElementById('ticketTableBody');

        if (tickets.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="10">
                        <div class="empty-state">
                            ${Icons.render('folder-open')}
                            <p>No tickets match this view</p>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = tickets.map(ticket => `
            <tr>
                <td><label class="ticket-check-wrap"><input type="checkbox" class="ticket-select-checkbox" data-id="${ticket.id}" ${this.selectedTicketIds.has(ticket.id) ? 'checked' : ''}></label></td>
                <td><strong>${ticket.ticket_number}</strong></td>
                <td>${this._esc(ticket.title)}</td>
                <td>${this._esc(this.capitalize(ticket.category))}</td>
                <td><span class="priority-badge ${ticket.priority}">${this.capitalize(ticket.priority)}</span></td>
                <td><span class="status-badge ${ticket.status}">${this.capitalize(ticket.status.replace('_', ' '))}</span></td>
                <td>${this.slaBadge(ticket)}</td>
                <td>${this._esc(ticket.assigned_to || 'Unassigned')}</td>
                <td>${new Date(ticket.created_at).toLocaleDateString()}</td>
                <td>
                    <div class="action-buttons">
                        <button class="btn-secondary btn-sm" aria-label="Preview ticket" onclick="app.openTicketDetail(${ticket.id})">
                            ${Icons.render('eye')}
                        </button>
                        <button class="btn-secondary btn-sm" aria-label="Open workspace" onclick="app.openTicketWorkspace(${ticket.id})">
                            ${Icons.render('cog')}
                        </button>
                        <button class="btn-danger btn-sm" aria-label="Delete ticket" onclick="app.deleteTicket(${ticket.id})">
                            ${Icons.render('trash')}
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');

        document.querySelectorAll('.ticket-select-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const id = parseInt(e.target.dataset.id, 10);
                if (e.target.checked) {
                    this.selectedTicketIds.add(id);
                } else {
                    this.selectedTicketIds.delete(id);
                }
                this.updateBulkActionsBar();
            });
        });
    }

    async handleTicketSubmit(e) {
        const form = e.target;
        const formData = {
            title: document.getElementById('title').value,
            description: document.getElementById('description').value,
            category: document.getElementById('category').value,
            priority: document.getElementById('priority').value,
            assigned_to: document.getElementById('assignedTo').value || null,
            created_by: AuthAPI.getCurrentUser() ? AuthAPI.getCurrentUser().username : 'admin'
        };

        // createTicketOffline attaches a client_uuid and classifies the outcome:
        // ok / network failure (retryable) / HTTP error (server rejection).
        const result = await TicketAPI.createTicketOffline(formData);

        if (result.ok) {
            this.showToast('Ticket created successfully!');
            form.reset();
            await this.loadTickets();
            this.switchSection('tickets');
        } else if (result.network) {
            // Offline or server unreachable — the exact payload (with its
            // client_uuid) is kept locally and submitted by the sync loop.
            await this.enqueueTicket(formData);
            form.reset();
            this.showToast('Saved offline — will submit when online.');
            await this.updatePendingBadge();
        } else {
            if (result.status === 401 || result.status === 422) {
                AuthAPI.onSessionExpired();
            } else {
                this.showToast(result.error.message || 'Failed to create ticket. Please try again.', true);
            }
        }
    }

    // ============ Bulk Actions ============
    toggleSelectAll(checked) {
        if (checked) {
            this.filteredTickets.forEach(t => this.selectedTicketIds.add(t.id));
        } else {
            this.selectedTicketIds.clear();
        }
        this.renderTickets(this.filteredTickets);
        this.updateBulkActionsBar();
    }

    clearSelection() {
        this.selectedTicketIds.clear();
        document.getElementById('selectAllTickets').checked = false;
        this.renderTickets(this.filteredTickets);
        this.updateBulkActionsBar();
    }

    updateBulkActionsBar() {
        const bar = document.getElementById('bulkActionsBar');
        const count = this.selectedTicketIds.size;

        if (count === 0) {
            bar.style.display = 'none';
            return;
        }

        bar.style.display = 'flex';
        document.getElementById('bulkSelectedCount').textContent = `${count} selected`;

        const assignSelect = document.getElementById('bulkAssignSelect');
        const assigneeOptions = this.users
            .filter(u => u.is_active !== false)
            .map(u => `<option value="${this._esc(u.username)}">${this._esc(u.username)}</option>`)
            .join('');
        assignSelect.innerHTML = `<option value="">Assign To...</option><option value="__unassign__">Unassign</option>${assigneeOptions}`;
    }

    async applyBulkAction() {
        const status = document.getElementById('bulkStatusSelect').value;
        const assign = document.getElementById('bulkAssignSelect').value;

        if (!status && !assign) {
            this.showToast('Choose a status or assignee to apply.', true);
            return;
        }

        const updates = {};
        if (status) updates.status = status;
        if (assign) updates.assigned_to = assign === '__unassign__' ? null : assign;

        const ids = Array.from(this.selectedTicketIds);
        let successCount = 0;

        for (const id of ids) {
            try {
                await TicketAPI.updateTicket(id, updates);
                successCount++;
            } catch (error) {
                console.error(`Failed to update ticket ${id}:`, error);
            }
        }

        this.showToast(`Updated ${successCount} of ${ids.length} ticket(s).`);
        this.clearSelection();
        document.getElementById('bulkStatusSelect').value = '';
        document.getElementById('bulkAssignSelect').value = '';
        await this.loadTickets();
    }

    // ============ Ticket Detail Popup ============
    // Centered modal for a quick glance without leaving the queue view.
    openTicketDetail(id) {
        const ticket = this.tickets.find(t => t.id === id);
        if (!ticket) return;
        this.activeTicketId = id;

        const body = document.getElementById('ticketDetailBody');
        body.innerHTML = `
            <h2 style="margin-bottom:5px;">${this._esc(ticket.title)}</h2>
            <p style="color:#999;margin-bottom:20px;">${this._esc(ticket.ticket_number)}</p>

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

            <p style="margin-bottom:15px;"><strong>Requester:</strong> ${this._esc(ticket.created_by)}</p>
            <p style="margin-bottom:15px;"><strong>Assigned To:</strong> ${this._esc(ticket.assigned_to || 'Unassigned')}</p>
            <p style="margin-bottom:15px;"><strong>Category:</strong> ${this._esc(this.capitalize(ticket.category))}</p>
            <p style="margin-bottom:20px;"><strong>Description:</strong><br>${this._esc(ticket.description)}</p>

            ${ticket.resolution ? `<p style="margin-bottom:20px;"><strong>Resolution:</strong><br>${this._esc(ticket.resolution)}</p>` : ''}

            <div style="border-top:1px solid #f0f0f0;padding-top:15px;font-size:0.85rem;color:#999;margin-bottom:20px;">
                <p>Created: ${new Date(ticket.created_at).toLocaleString()}</p>
                <p>Last updated: ${new Date(ticket.updated_at).toLocaleString()}</p>
            </div>

            <div style="border-top:1px solid #f0f0f0;padding-top:15px;margin-bottom:20px;">
                <h3 style="margin-bottom:12px;">Attachments</h3>
                <div id="ticketDetailAttachmentList"><p style="color:#999;">Loading...</p></div>
            </div>

            <div style="border-top:1px solid #f0f0f0;padding-top:15px;">
                <h3 style="margin-bottom:12px;">Conversation</h3>
                <div id="ticketDetailCommentList"><p style="color:#999;">Loading...</p></div>
            </div>

            <div style="margin-top:20px;text-align:right;">
                <button class="btn-primary btn-sm" onclick="document.getElementById('ticketDetailModal').style.display='none'; app.openTicketWorkspace(${ticket.id})">Open Full Workspace</button>
            </div>
        `;

        document.getElementById('ticketDetailModal').style.display = 'block';
        this.loadTicketDetailAttachments(id);
        this.loadTicketDetailComments(id);
    }

    loadTicketDetailComments(ticketId) {
        const container = document.getElementById('ticketDetailCommentList');
        TicketAPI.getTicketComments(ticketId).then(comments => {
            if (comments.length === 0) {
                container.innerHTML = '<p style="color:#999;font-size:0.9rem;">No replies yet.</p>';
                return;
            }
            container.innerHTML = comments.map(c => `
                <div style="${c.is_internal ? 'background:var(--surface-alt, #eef2f7);border-radius:6px;' : ''}padding:10px 0;border-bottom:1px solid #f5f5f5;${c.is_internal ? 'padding:10px;' : ''}">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <div style="display:flex;align-items:center;gap:8px;">
                            <strong style="font-size:0.9rem;">${this._esc(c.author_username)}</strong>
                            <span class="role-badge ${c.author_role}">${this.capitalize(c.author_role)}</span>
                            ${c.is_internal ? '<span class="role-badge internal">Internal note</span>' : ''}
                        </div>
                        <span style="font-size:0.75rem;color:#999;">${new Date(c.created_at).toLocaleString()}</span>
                    </div>
                    <p style="margin-top:4px;font-size:0.9rem;">${this._esc(c.message)}</p>
                </div>
            `).join('');
        }).catch(() => {
            container.innerHTML = '<p style="color:#999;font-size:0.9rem;">Could not load replies.</p>';
        });
    }

    loadTicketDetailAttachments(ticketId) {
        const container = document.getElementById('ticketDetailAttachmentList');
        TicketAPI.getAttachments(ticketId).then(atts => {
            if (atts.length === 0) {
                container.innerHTML = '<p style="color:#999;font-size:0.9rem;">No files attached yet.</p>';
                return;
            }
            container.innerHTML = atts.map(a => `
                <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f5f5f5;">
                    ${Icons.render('paperclip', { style: 'color:#999;' })}
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this._esc(a.original_filename)}</span>
                    <span style="font-size:0.75rem;color:#999;white-space:nowrap;">${this.formatFileSize(a.file_size)}</span>
                    <button class="btn-secondary btn-sm" aria-label="Download attachment" onclick="app.downloadTicketDetailAttachment(${a.id})">
                        ${Icons.render('download')}
                    </button>
                </div>
            `).join('');
        }).catch(() => {
            container.innerHTML = '<p style="color:#999;font-size:0.9rem;">Could not load attachments.</p>';
        });
    }

    async downloadTicketDetailAttachment(attachmentId) {
        try {
            const reloaded = await TicketAPI.getAttachments(this.activeTicketId);
            const found = reloaded.find(a => a.id === attachmentId);
            if (found) {
                await TicketAPI.downloadAttachment(found, (msg) => this.showToast(msg, true));
            } else {
                this.showToast('This file is no longer available.', true);
            }
        } catch (error) {
            this.showToast('Could not load attachments — please try again.', true);
            console.error(error);
        }
    }

    // ============ Ticket Workspace ============
    // Unified view + edit surface, replacing the old prompt()-based status change.
    // Technician dropdown is populated from real staff/admin users — not freeform text.
    openTicketWorkspace(id) {
        const ticket = this.tickets.find(t => t.id === id);
        if (!ticket) return;
        this.activeTicketId = id;

        document.getElementById('workspaceTicketTitle').textContent = ticket.title;
        document.getElementById('workspaceTicketNumber').textContent = ticket.ticket_number;
        document.getElementById('workspaceRequester').textContent = ticket.created_by;
        document.getElementById('workspaceDescription').textContent = ticket.description;
        document.getElementById('workspaceCreated').textContent = new Date(ticket.created_at).toLocaleString();
        document.getElementById('workspaceUpdated').textContent = new Date(ticket.updated_at).toLocaleString();

        document.getElementById('workspaceSla').innerHTML = this.slaDueHtml(ticket);

        document.getElementById('workspaceStatus').value = ticket.status;
        document.getElementById('workspacePriority').value = ticket.priority;
        document.getElementById('workspaceResolution').value = ticket.resolution || '';

        const technicianSelect = document.getElementById('workspaceAssignedTo');
        const assigneeOptions = this.users
            .filter(u => u.is_active !== false)
            .map(u => `<option value="${this._esc(u.username)}" ${u.username === ticket.assigned_to ? 'selected' : ''}>${this._esc(u.username)} (${this.capitalize(u.role)})</option>`)
            .join('');
        technicianSelect.innerHTML = `<option value="">Unassigned</option>${assigneeOptions}`;

        document.getElementById('ticketWorkspaceModal').style.display = 'block';
        this.loadWorkspaceComments(id);
        this.loadWorkspaceAttachments(id);
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
        const resp = line('SLA response due', ticket.sla_response_due, active && ticket.sla_response_breached);
        const resol = line('SLA resolution due', ticket.sla_resolution_due, active && ticket.sla_resolution_breached);
        return `<span>${resp}${resol}</span>`;
    }

    async loadWorkspaceAttachments(ticketId) {
        const container = document.getElementById('workspaceAttachmentList');
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
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this._esc(a.original_filename)}</span>
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

    async handleWorkspaceAttachmentSubmit() {
        const input = document.getElementById('workspaceAttachmentInput');
        const file = input.files && input.files[0];
        if (!file || !this.activeTicketId) return;

        try {
            await TicketAPI.uploadAttachment(this.activeTicketId, file);
            input.value = '';
            this.showToast('File uploaded.');
            await this.loadWorkspaceAttachments(this.activeTicketId);
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
            await this.loadWorkspaceAttachments(this.activeTicketId);
        } catch (error) {
            this.showToast('Failed to delete attachment.', true);
            console.error(error);
        }
    }

    async handleWorkspaceSave() {
        const updates = {
            status: document.getElementById('workspaceStatus').value,
            priority: document.getElementById('workspacePriority').value,
            assigned_to: document.getElementById('workspaceAssignedTo').value || null,
            resolution: document.getElementById('workspaceResolution').value
        };

        try {
            await TicketAPI.updateTicket(this.activeTicketId, updates);
            this.showToast('Ticket updated successfully!');
            document.getElementById('ticketWorkspaceModal').style.display = 'none';
            await this.loadTickets();
        } catch (error) {
            this.showToast('Failed to update ticket.', true);
            console.error(error);
        }
    }

    async deleteTicket(id) {
        if (!confirm('Are you sure you want to delete this ticket? This cannot be undone.')) return;

        try {
            await TicketAPI.deleteTicket(id);
            this.showToast('Ticket deleted successfully!');
            document.getElementById('ticketWorkspaceModal').style.display = 'none';
            await this.loadTickets();
        } catch (error) {
            this.showToast('Failed to delete ticket.', true);
            console.error(error);
        }
    }

    // ============ Ticket Conversation (reuses the same backend as the User Portal) ============
    async loadWorkspaceComments(ticketId) {
        const container = document.getElementById('workspaceCommentList');
        container.innerHTML = '<p style="color:#999;">Loading...</p>';

        let comments;
        try {
            comments = await TicketAPI.getTicketComments(ticketId);
        } catch (error) {
            container.innerHTML = '<p style="color:#999;font-size:0.9rem;">Requires connection to load replies.</p>';
            return;
        }
        if (comments.length === 0) {
            container.innerHTML = '<p style="color:#999;font-size:0.9rem;">No replies yet.</p>';
            return;
        }

        container.innerHTML = comments.map(c => `
            <div style="${c.is_internal ? 'background:var(--surface-alt, #eef2f7);border-radius:6px;' : ''}padding:10px 0;border-bottom:1px solid #f5f5f5;${c.is_internal ? 'padding:10px;' : ''}">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <strong style="font-size:0.9rem;">${this._esc(c.author_username)}</strong>
                        <span class="role-badge ${c.author_role}">${this.capitalize(c.author_role)}</span>
                        ${c.is_internal ? '<span class="role-badge internal">Internal note</span>' : ''}
                    </div>
                    <span style="font-size:0.75rem;color:#999;">${new Date(c.created_at).toLocaleString()}</span>
                </div>
                <p style="margin-top:4px;font-size:0.9rem;">${this._esc(c.message)}</p>
            </div>
        `).join('');
    }

    async handleWorkspaceCommentSubmit() {
        const input = document.getElementById('workspaceCommentInput');
        const message = input.value.trim();
        if (!message || !this.activeTicketId) return;

        const internalBox = document.getElementById('workspaceCommentInternal');
        const isInternal = internalBox ? internalBox.checked : false;

        // Stamp one uuid now so the queued copy and any replay reuse the SAME
        // uuid — the server dedups on it, so an offline reply can never land
        // twice even if a commit landed but its response was lost.
        const itemUuid = TicketAPI.generateClientUuid();

        // createTicketCommentOffline attaches the client_uuid and classifies the
        // outcome: ok / network failure (retryable, queued) / HTTP error.
        const result = await TicketAPI.createTicketCommentOffline(this.activeTicketId, message, isInternal, itemUuid);

        if (result.ok) {
            input.value = '';
            if (internalBox) internalBox.checked = false;
            await this.loadWorkspaceComments(this.activeTicketId);
        } else if (result.network) {
            // Offline or server unreachable — the exact payload (with its
            // client_uuid) is kept locally and submitted by the sync loop.
            await this.enqueueComment({
                client_uuid: itemUuid,
                ticket_id: this.activeTicketId,
                message: message,
                is_internal: isInternal
            });
            input.value = '';
            if (internalBox) internalBox.checked = false;
            this.showToast('Saved offline — will send when online.');
        } else {
            if (result.status === 401 || result.status === 422) {
                AuthAPI.onSessionExpired();
            } else {
                this.showToast(result.error.message || 'Failed to post reply. Please try again.', true);
            }
        }
    }

    // ============ Users ============
    populateAssignedToSelect() {
        const select = document.getElementById('assignedTo');
        const assigneeOptions = this.users
            .filter(u => u.is_active !== false)
            .map(u => `<option value="${this._esc(u.username)}">${this._esc(u.username)} (${this.capitalize(u.role)})</option>`)
            .join('');
        select.innerHTML = `<option value="">Unassigned</option>${assigneeOptions}`;
    }

    async populateDepartmentSelects() {
        const departments = await TicketAPI.getDepartments();
        this.departments = departments;
        const options = departments.map(d => `<option value="${this._esc(d.name)}">${this._esc(d.name)}</option>`).join('');
        const deptHtml = `<option value="">Select department</option>${options}`;
        document.getElementById('department').innerHTML = deptHtml;
        document.getElementById('editDepartment').innerHTML = deptHtml;
        const profileDept = document.getElementById('adminProfileDepartment');
        if (profileDept) profileDept.innerHTML = deptHtml;
        const filterDept = document.getElementById('userDepartmentFilter');
        if (filterDept) filterDept.innerHTML = `<option value="all">All Departments</option>${options}`;
    }

    async loadUsers() {
        try {
            this.users = await TicketAPI.getUsers();
            this.usersLoadError = false;
        } catch (error) {
            console.error('Error loading users:', error);
            this.usersLoadError = true;
        }
    }

    applyUserFilters() {
        const role = document.getElementById('userRoleFilter').value;
        const status = document.getElementById('userStatusFilter').value;
        const dept = document.getElementById('userDepartmentFilter').value;
        const q = (document.getElementById('searchUser').value || '').toLowerCase().trim();

        this.filteredUsers = (this.users || []).filter(user => {
            if (role !== 'all' && user.role !== role) return false;
            if (status === 'active' && user.is_active === false) return false;
            if (status === 'inactive' && user.is_active !== false) return false;
            if (dept !== 'all' && (user.department || '') !== dept) return false;
            if (q) {
                const hay = ((user.username || '') + ' ' + (user.email || '') + ' ' + (user.department || '')).toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });
    }

    renderUsers() {
        this.applyUserFilters();
        const currentUsername = (AuthAPI.getCurrentUser() || {}).username || '';
        const tbody = document.getElementById('userTableBody');
        const countEl = document.getElementById('userResultCount');

        if ((this.users || []).length === 0) {
            const msg = this.usersLoadError
                ? 'Unable to load users. Requires a connection.'
                : 'No users found';
            tbody.innerHTML = `
                <tr>
                    <td colspan="6">
                        <div class="empty-state">
                            ${Icons.render(this.usersLoadError ? 'wifi' : 'users')}
                            <p>${msg}</p>
                        </div>
                    </td>
                </tr>
            `;
            if (countEl) countEl.textContent = '';
            return;
        }

        if (this.filteredUsers.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6">
                        <div class="empty-state">
                            ${Icons.render('users')}
                            <p>No users match the current filters</p>
                        </div>
                    </td>
                </tr>
            `;
            if (countEl) countEl.textContent = '';
            return;
        }

        tbody.innerHTML = this.filteredUsers.map(user => `
            <tr style="${user.is_active === false ? 'opacity:0.5;' : ''}">
                <td>
                    <div class="user-cell">
                        <span class="user-avatar" aria-hidden="true">${this._esc((user.username || '?').charAt(0) || '?')}</span>
                        <strong>${this._esc(user.username)}</strong>
                    </div>
                </td>
                <td>${this._esc(user.email)}</td>
                <td><span class="role-badge ${this._roleBadgeClass(user.role)}">${this.capitalize(user.role || 'staff')}</span></td>
                <td>${user.department ? this._esc(user.department) : 'N/A'}</td>
                <td>${user.is_active === false ? '<span class="status-badge resolved" style="background:#f5f5f5;color:#999;">Inactive</span>' : '<span class="status-badge open">Active</span>'}</td>
                <td>
                    <div class="action-buttons">
                        <button class="btn-secondary btn-sm" aria-label="View user details" onclick="app.openUserDetail(${user.id})">
                            ${Icons.render('eye')}
                        </button>
                        <button class="btn-secondary btn-sm" aria-label="Edit user" onclick="app.openEditUserModal(${user.id})">
                            ${Icons.render('cog')}
                        </button>
                        ${user.is_active === false
                            ? `<button class="btn-secondary btn-sm" aria-label="Reactivate user" onclick="app.reactivateUser(${user.id})">${Icons.render('undo')}</button>`
                            : `<button class="btn-danger btn-sm" aria-label="Deactivate user" onclick="app.deleteUser(${user.id})">${Icons.render('user-slash')}</button>`
                        }
                        ${user.username !== currentUsername
                            ? `<button class="btn-danger btn-sm" aria-label="Delete user permanently" onclick="app.purgeUser(${user.id})">${Icons.render('trash')}</button>`
                            : ''
                        }
                    </div>
                </td>
            </tr>
        `).join('');

        if (countEl) countEl.textContent = `Showing ${this.filteredUsers.length} of ${(this.users || []).length}`;
    }

    async handleUserSubmit(e) {
        const form = e.target;
        const formData = {
            username: document.getElementById('username').value,
            email: document.getElementById('email').value,
            password: document.getElementById('password').value,
            role: document.getElementById('role').value,
            department: document.getElementById('department').value || null
        };

        try {
            await TicketAPI.createUser(formData);
            this.showToast('User created successfully!');
            form.reset();
            document.getElementById('userModal').style.display = 'none';
            await this.loadUsers();
            this.renderUsers();
        } catch (error) {
            this.showToast('Failed to create user. Please try again.', true);
            console.error(error);
        }
    }

    async deleteUser(id) {
        if (!confirm('Deactivate this user? They will no longer be able to log in, but their ticket history is preserved.')) return;

        try {
            await TicketAPI.deleteUser(id);
            this.showToast('User deactivated successfully!');
            await this.loadUsers();
            this.renderUsers();
        } catch (error) {
            this.showToast('Failed to deactivate user.', true);
            console.error(error);
        }
    }

    async purgeUser(id) {
        if (!confirm('Permanently delete this user? This removes the account and cannot be undone. Ticket and comment history referencing them is preserved.')) return;

        try {
            await TicketAPI.purgeUser(id);
            this.showToast('User permanently deleted.');
            await this.loadUsers();
            this.renderUsers();
        } catch (error) {
            this.showToast('Failed to permanently delete user.', true);
            console.error(error);
        }
    }

    async reactivateUser(id) {
        try {
            await TicketAPI.reactivateUser(id);
            this.showToast('User reactivated successfully!');
            await this.loadUsers();
            this.renderUsers();
        } catch (error) {
            this.showToast('Failed to reactivate user.', true);
            console.error(error);
        }
    }

    // ============ Edit User (role/department management) ============
    // Username is deliberately immutable — it's referenced throughout tickets/comments
    // (created_by, assigned_to, author_username), so renaming would orphan history.
    openEditUserModal(id) {
        const user = this.users.find(u => u.id === id);
        if (!user) return;
        this.activeEditUserId = id;

        this.populateRoleSelects();
        this.populateDepartmentSelects().then(() => {
            document.getElementById('editUsername').value = user.username;
            document.getElementById('editEmail').value = user.email;
            document.getElementById('editRole').value = user.role;
            document.getElementById('editDepartment').value = user.department || '';
            document.getElementById('editPhone').value = user.phone || '';
        });

        document.getElementById('editUserModal').style.display = 'block';
    }

    async handleEditUserSubmit() {
        const updates = {
            username: document.getElementById('editUsername').value.trim(),
            email: document.getElementById('editEmail').value,
            role: document.getElementById('editRole').value,
            department: document.getElementById('editDepartment').value || null
        };

        try {
            const data = await TicketAPI.updateUser(this.activeEditUserId, updates);
            // Renaming YOURSELF re-issues tokens; swap them so the sidebar and
            // subsequent requests carry the new identity.
            if (data.access_token && data.refresh_token) {
                AuthAPI.setTokens(data.access_token, data.refresh_token);
                if (data.user) sessionStorage.setItem('current_user', JSON.stringify(data.user));
                this.renderIdentity();
            }
            this.showToast('User updated successfully!');
            document.getElementById('editUserModal').style.display = 'none';
            await this.loadUsers();
            this.renderUsers();
        } catch (error) {
            this.showToast(error.message, true);
        }
    }

    // ============ Link Phone (USSD, Phase 3) ============
    // Sends only the phone change to the new /api/users/<id>/link-phone endpoint;
    // it never touches email/role/department (those go through Save Changes). An
    // empty value unlinks the phone.
    async handleLinkPhone() {
        const phone = document.getElementById('editPhone').value.trim();
        if (!this.activeEditUserId) return;
        try {
            const response = await apiFetch(`/api/users/${this.activeEditUserId}/link-phone`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to link phone');
            const username = document.getElementById('editUsername').value;
            this.showToast(phone ? `Phone ${phone} linked to ${username}` : 'Phone unlinked');
        } catch (error) {
            this.showToast(error.message, true);
        }
    }

    // ============ User Detail (Pass 2) ============
    // Read-only overview of a single user, opened from the Users table. Quick
    // actions delegate to the existing edit / deactivate / reactivate / reset-2fa
    // flows rather than duplicating them.
    openUserDetail(id) {
        const user = this.users.find(u => u.id === id);
        if (!user) return;
        this.activeDetailUserId = id;

        const initial = (user.username || '?').charAt(0).toUpperCase();
        document.getElementById('userDetailAvatar').textContent = initial;
        document.getElementById('userDetailName').textContent = `@${user.username}`;
        document.getElementById('userDetailRole').textContent = this.capitalize(user.role || 'staff');
        document.getElementById('userDetailRole').className = `role-badge ${this._roleBadgeClass(user.role)}`;
        document.getElementById('userDetailEmail').textContent = user.email || 'N/A';
        document.getElementById('userDetailDepartment').textContent = user.department || 'N/A';
        document.getElementById('userDetailPhone').textContent = user.phone || 'Not linked';

        const active = user.is_active !== false;
        document.getElementById('userDetailStatus').innerHTML = active
            ? '<span class="status-badge open">Active</span>'
            : '<span class="status-badge resolved" style="background:#f5f5f5;color:#999;">Inactive</span>';

        document.getElementById('userDetail2fa').textContent = user.totp_enabled ? 'Enabled' : 'Not enabled';

        const lockedUntil = user.locked_until;
        document.getElementById('userDetailLock').textContent = lockedUntil
            ? `Locked until ${new Date(lockedUntil).toLocaleString()}`
            : 'Not locked';

        const toggleBtn = document.getElementById('userDetailToggleActiveBtn');
        toggleBtn.textContent = active ? 'Deactivate' : 'Reactivate';
        toggleBtn.className = active ? 'btn-danger btn-sm' : 'btn-primary btn-sm';

        document.getElementById('userDetailModal').style.display = 'block';
    }

    async resetUser2fa() {
        if (!this.activeDetailUserId) return;
        if (!confirm('Clear two-factor authentication for this user?')) return;
        try {
            const response = await apiFetch(`/api/users/${this.activeDetailUserId}/reset-2fa`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to reset 2FA');
            this.showToast(data.message || 'Two-factor authentication cleared');
            await this.loadUsers();
            this.renderUsers();
            const user = this.users.find(u => u.id === this.activeDetailUserId);
            if (user) document.getElementById('userDetail2fa').textContent = user.totp_enabled ? 'Enabled' : 'Not enabled';
        } catch (error) {
            this.showToast(error.message, true);
        }
    }

    // ============ Settings: Categories & Departments ============
    async loadCategories() {
        const container = document.getElementById('categoryList');
        container.innerHTML = '<p style="color:#999;">Loading...</p>';

        const categories = await TicketAPI.getCategories();
        this.renderCategoryList(categories);
    }

    renderCategoryList(categories) {
        const container = document.getElementById('categoryList');

        if (categories.length === 0) {
            container.innerHTML = '<p style="color:#999;">No categories yet.</p>';
            return;
        }

        container.innerHTML = categories.map(c => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f5f5f5;">
                <span>${this._esc(this.capitalize(c.name))}</span>
                <button class="btn-danger btn-sm" aria-label="Remove category" onclick="app.removeCategory(${c.id})">
                    ${Icons.render('trash')}
                </button>
            </div>
        `).join('');
    }

    async handleAddCategory() {
        const input = document.getElementById('newCategoryName');
        const name = input.value.trim().toLowerCase();
        if (!name) return;

        try {
            await TicketAPI.createCategory(name);
            this.showToast('Category added successfully!');
            input.value = '';
            await this.loadCategories();
        } catch (error) {
            this.showToast(error.message, true);
        }
    }

    async removeCategory(id) {
        if (!confirm('Remove this category? It will no longer appear as an option, but existing tickets keep it.')) return;

        try {
            await TicketAPI.deleteCategory(id);
            this.showToast('Category removed.');
            await this.loadCategories();
        } catch (error) {
            this.showToast('Failed to remove category.', true);
        }
    }

    async loadDepartments() {
        const container = document.getElementById('departmentList');
        container.innerHTML = '<p style="color:#999;">Loading...</p>';

        const departments = await TicketAPI.getDepartments();
        this.renderDepartmentList(departments);
    }

    renderDepartmentList(departments) {
        const container = document.getElementById('departmentList');

        if (departments.length === 0) {
            container.innerHTML = '<p style="color:#999;">No departments yet.</p>';
            return;
        }

        container.innerHTML = departments.map(d => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f5f5f5;">
                <span>${this._esc(d.name)}</span>
                <button class="btn-danger btn-sm" aria-label="Remove department" onclick="app.removeDepartment(${d.id})">
                    ${Icons.render('trash')}
                </button>
            </div>
        `).join('');
    }

    async handleAddDepartment() {
        const input = document.getElementById('newDepartmentName');
        const name = input.value.trim();
        if (!name) return;

        try {
            await TicketAPI.createDepartment(name);
            this.showToast('Department added successfully!');
            input.value = '';
            await this.loadDepartments();
        } catch (error) {
            this.showToast(error.message, true);
        }
    }

    async removeDepartment(id) {
        if (!confirm('Remove this department? It will no longer appear as an option, but existing users keep it.')) return;

        try {
            await TicketAPI.deleteDepartment(id);
            this.showToast('Department removed.');
            await this.loadDepartments();
        } catch (error) {
            this.showToast('Failed to remove department.', true);
        }
    }

    // ============ Settings: Roles (classification labels) ============
    // Roles are labels stored on User.role. Only 'admin' grants elevated access;
    // others are staff-tier (open to any authenticated user). The registry lives
    // in the backend; role change takes effect at the user's next login (role is
    // baked into the JWT claim at login time).
    async loadRoles() {
        const container = document.getElementById('roleList');
        container.innerHTML = '<p style="color:#999;">Loading...</p>';

        const roles = await TicketAPI.getRoles();
        this.roles = roles;
        this.renderRoleList(roles);
        this.populateRoleSelects();
    }

    renderRoleList(roles) {
        const container = document.getElementById('roleList');

        if (roles.length === 0) {
            container.innerHTML = '<p style="color:#999;">No roles yet.</p>';
            return;
        }

        container.innerHTML = roles.map(r => {
            const badge = r.is_active === false ? 'disabled' : (r.name === 'admin' ? 'admin' : (r.name === 'staff' ? 'staff' : 'custom'));
            return `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f5f5f5;${r.is_active === false ? 'opacity:0.5;' : ''}">
                <div style="display:flex;align-items:center;gap:10px;">
                    <span>${this._esc(this.capitalize(r.name))}</span>
                    <span class="role-badge ${badge}">${r.is_active === false ? 'Disabled' : 'Active'}</span>
                </div>
                ${r.name === 'admin'
                    ? '<span style="font-size:0.75rem;color:#999;">Required</span>'
                    : `<button class="btn-danger btn-sm" aria-label="${r.is_active === false ? 'Reactivate' : 'Deactivate'} role" onclick="app.removeRole(${r.id}, ${r.is_active === false})">
                        ${Icons.render(r.is_active === false ? 'undo' : 'trash')}
                    </button>`}
            </div>
        `;
        }).join('');
    }

    async handleAddRole() {
        const input = document.getElementById('newRoleName');
        const name = input.value.trim().toLowerCase();
        if (!name) return;

        try {
            await TicketAPI.createRole(name);
            this.showToast('Role added successfully!');
            input.value = '';
            await this.loadRoles();
        } catch (error) {
            this.showToast(error.message, true);
        }
    }

    async removeRole(id, isDisabled = false) {
        if (!isDisabled && !confirm('Deactivate this role? Users with it keep the label, but no new user can be assigned it, and it is hidden from role filters.')) return;

        try {
            if (isDisabled) {
                const role = (this.roles || []).find(r => r.id === id);
                if (role) {
                    await TicketAPI.createRole(role.name);
                    this.showToast('Role reactivated.');
                }
            } else {
                await TicketAPI.deactivateRole(id);
                this.showToast('Role deactivated.');
            }
            await this.loadRoles();
        } catch (error) {
            this.showToast(error.message, true);
        }
    }

    // Keep the three role-bearing selects in sync with the registry. Only active
    // roles are assignable. 'staff' is preselected in the add/edit selectors so
    // new (and edited) users never silently default to admin.
    populateRoleSelects() {
        const all = (this.roles || []);
        if (all.length === 0) return; // fetch failed or nothing loaded — keep static markup
        const active = all.filter(r => r.is_active !== false);
        const option = (r, selected) => `<option value="${this._esc(r.name)}"${selected ? ' selected' : ''}>${this._esc(this.capitalize(r.name))}</option>`;

        const filter = document.getElementById('userRoleFilter');
        if (filter) filter.innerHTML = `<option value="all">All Roles</option>${active.map(r => option(r, false)).join('')}`;

        const addSelect = document.getElementById('role');
        if (addSelect) addSelect.innerHTML = active.map(r => option(r, r.name === 'staff')).join('');

        // Edit selector keeps inactive roles as non-selectable options so a user
        // with a disabled role isn't silently downgraded when saving other fields.
        const editSelect = document.getElementById('editRole');
        if (editSelect) editSelect.innerHTML = all
            .map(r => r.is_active !== false
                ? option(r, r.name === 'staff')
                : `<option value="${this._esc(r.name)}" disabled>${this._esc(this.capitalize(r.name))} (inactive)</option>`)
            .join('');
    }

    _roleBadgeClass(role) {
        const r = role || 'staff';
        return (r === 'admin' || r === 'staff') ? r : 'custom';
    }

    // ============ Reports ============
    async loadReports() {
        const from = document.getElementById('reportFrom').value;
        const to = document.getElementById('reportTo').value;
        const report = await TicketAPI.getReportSummary(from, to);
        if (!report) {
            this.showToast('Failed to load report.', true);
            return;
        }

        const t = report.totals || {};
        document.getElementById('reportTotal').textContent = report.period?.total || 0;
        document.getElementById('reportResolved').textContent = t.resolved || 0;
        document.getElementById('reportRate').textContent = (t.resolution_rate_pct ?? 0) + '%';

        const fmtHours = (h) => h == null ? '—' : `${h}h`;
        document.getElementById('reportAvgResolution').textContent = fmtHours(report.avg_resolution_hours);
        document.getElementById('reportAvgResponse').textContent = fmtHours(report.avg_response_hours);
        const sla = report.sla || {};
        document.getElementById('reportSlaBreaches').textContent = (sla.response_breaches || 0) + (sla.resolution_breaches || 0);

        const cats = report.categories || [];
        const pri = report.priorities || [];

        this.renderReportCharts(report);

        document.getElementById('reportPriorities').innerHTML = pri.length
            ? pri.map(p => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f5f5f5;"><span>${this.capitalize(p.priority)}</span><strong>${p.count}</strong></div>`).join('')
            : '<p style="color:#999;">No data.</p>';

        const tech = report.technicians || [];
        document.getElementById('reportTechnicians').innerHTML = tech.length
            ? tech.map(x => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f5f5f5;"><span>${this._esc(x.username)}</span><span style="color:#666;font-size:0.85rem;">${x.assigned} assigned · ${x.resolved} resolved</span></div>`).join('')
            : '<p style="color:#999;">No data.</p>';
    }

    renderReportCharts(report) {
        if (typeof Chart === 'undefined') return;

        if (this.trendChartInstance) this.trendChartInstance.destroy();
        if (this.categoryChartInstance) this.categoryChartInstance.destroy();

        const daily = report.daily || [];
        if (daily.length && document.getElementById('trendChart')) {
            this.trendChartInstance = new Chart(document.getElementById('trendChart'), {
                type: 'line',
                data: {
                    labels: daily.map(d => d.date),
                    datasets: [
                        { label: 'Created', data: daily.map(d => d.created), borderColor: '#1976d2', backgroundColor: 'rgba(25,118,210,0.12)', fill: true, tension: 0.25, pointRadius: 2 },
                        { label: 'Resolved', data: daily.map(d => d.resolved), borderColor: '#2e7d32', backgroundColor: 'rgba(46,125,50,0.12)', fill: true, tension: 0.25, pointRadius: 2 }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom', labels: { boxWidth: 14 } } },
                    scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
                }
            });
        }

        const cats = report.categories || [];
        const catCanvas = document.getElementById('categoryChart');
        if (cats.length && catCanvas) {
            const palette = ['#1976d2', '#2e7d32', '#e65100', '#6a1b9a', '#c62828', '#00838f'];
            this.categoryChartInstance = new Chart(catCanvas, {
                type: 'doughnut',
                data: {
                    labels: cats.map(c => this.capitalize(c.category)),
                    datasets: [{ data: cats.map(c => c.count),
                        backgroundColor: cats.map((_, i) => palette[i % palette.length]) }]
                },
                options: { responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'right', labels: { boxWidth: 12 } } } }
            });
        }
    }

    async exportReport(scope) {
        const from = document.getElementById('reportFrom').value;
        const to = document.getElementById('reportTo').value;
        await TicketAPI.downloadReportCSV(scope, from, to, (msg) => this.showToast(msg, true));
    }

    // ============ Knowledge Base management ============
    async populateKBCategories() {
        const categories = await TicketAPI.getCategories();
        const select = document.getElementById('kbCategoryFilter');
        select.innerHTML = `<option value="all">All Categories</option>` +
            categories.map(c => `<option value="${this._esc(c.name)}">${this._esc(this.capitalize(c.name))}</option>`).join('');

        const datalist = document.getElementById('kbCategoryOptions');
        datalist.innerHTML = categories.map(c => `<option value="${this._esc(c.name)}">`).join('');
    }

    async loadKnowledgeArticles() {
        const tbody = document.getElementById('kbArticleBody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:30px;color:#999;">' + Icons.render('spinner', { state: 'loading' }) + ' Loading...</td></tr>';

        const query = document.getElementById('kbSearch').value.trim();
        const category = document.getElementById('kbCategoryFilter').value;
        const meta = await TicketAPI.getKnowledgeArticlesWithMeta(query, category);

        if (!meta.ok && !meta.fromCache) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6">
                        <div class="empty-state" style="padding:30px;">
                            ${Icons.render('wifi')}
                            <p>Requires connection to load the knowledge base.</p>
                            <button type="button" class="btn-secondary btn-sm" style="margin-top:10px;" onclick="app.loadKnowledgeArticles()">Retry</button>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }

        const articles = meta.articles;
        this.kbArticles = articles;

        if (articles.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">' + Icons.render('book') + '<p>No articles found.</p></div></td></tr>';
            return;
        }

        tbody.innerHTML = articles.map(a => `
            <tr>
                <td><strong>${this._esc(a.title)}</strong></td>
                <td>${this._esc(this.capitalize(a.category))}</td>
                <td>${this._esc(a.author_username || '—')}</td>
                <td>${a.is_published
                    ? '<span class="status-badge open">Published</span>'
                    : '<span class="status-badge resolved" style="background:#f5f5f5;color:#999;">Draft</span>'}</td>
                <td>${a.updated_at ? new Date(a.updated_at).toLocaleDateString() : '—'}</td>
                <td>
                    <div class="action-buttons">
                        <button class="btn-secondary btn-sm" aria-label="${a.is_published ? 'Unpublish' : 'Publish'} article" onclick="app.toggleKBPublished(${a.id})">
                            ${Icons.render(a.is_published ? 'eye-slash' : 'eye')}
                        </button>
                        <button class="btn-secondary btn-sm" aria-label="Edit article" onclick="app.openEditKBArticle(${a.id})">
                            ${Icons.render('cog')}
                        </button>
                        <button class="btn-danger btn-sm" aria-label="Delete article" onclick="app.deleteKBArticle(${a.id})">
                            ${Icons.render('trash')}
                        </button>
                    </div>
                </td>
            </tr>
        `).join('');
    }

    openNewKBArticle() {
        this.activeArticleId = null;
        document.getElementById('kbModalTitle').textContent = 'New Article';
        document.getElementById('kbForm').reset();
        document.getElementById('kbPublished').checked = true;
        document.getElementById('kbModal').style.display = 'block';
    }

    openEditKBArticle(id) {
        const article = this.kbArticles.find(a => a.id === id);
        if (!article) return;
        this.activeArticleId = id;
        document.getElementById('kbModalTitle').textContent = 'Edit Article';
        document.getElementById('kbTitle').value = article.title;
        document.getElementById('kbCategory').value = article.category;
        document.getElementById('kbContent').value = article.content;
        document.getElementById('kbPublished').checked = !!article.is_published;
        document.getElementById('kbModal').style.display = 'block';
    }

    async saveKBArticle() {
        const payload = {
            title: document.getElementById('kbTitle').value.trim(),
            category: document.getElementById('kbCategory').value.trim().toLowerCase(),
            content: document.getElementById('kbContent').value.trim(),
            is_published: document.getElementById('kbPublished').checked
        };
        try {
            if (this.activeArticleId) {
                await TicketAPI.updateKbArticle(this.activeArticleId, payload);
                this.showToast('Article updated.');
            } else {
                await TicketAPI.createKbArticle(payload);
                this.showToast('Article created.');
            }
            document.getElementById('kbModal').style.display = 'none';
            await this.loadKnowledgeArticles();
        } catch (error) {
            this.showToast(error.message || 'Failed to save article.', true);
        }
    }

    async deleteKBArticle(id) {
        if (!confirm('Delete this article permanently?')) return;
        try {
            await TicketAPI.deleteKbArticle(id);
            this.showToast('Article deleted.');
            await this.loadKnowledgeArticles();
        } catch (error) {
            this.showToast('Failed to delete article.', true);
        }
    }

    async toggleKBPublished(id) {
        const article = this.kbArticles.find(a => a.id === id);
        if (!article) return;
        try {
            await TicketAPI.updateKbArticle(id, { is_published: !article.is_published });
            await this.loadKnowledgeArticles();
        } catch (error) {
            this.showToast('Failed to update article.', true);
        }
    }

    // ============ Settings: SLA & System ============
    async loadSettings() {
        await this.loadCategories();
        await this.loadDepartments();
        await this.loadRoles();
        await this.loadSystemSettings();
        await this.loadPriorityRules();
    }

    async loadSystemSettings() {
        const s = await TicketAPI.getSettings();
        if (!s) return;
        const map = {
            set_sla_response_high: 'sla_response_high',
            set_sla_response_medium: 'sla_response_medium',
            set_sla_response_low: 'sla_response_low',
            set_sla_resolution_high: 'sla_resolution_high',
            set_sla_resolution_medium: 'sla_resolution_medium',
            set_sla_resolution_low: 'sla_resolution_low',
            set_ticket_prefix: 'ticket_prefix',
            set_site_name: 'site_name',
            set_sla_sweep_interval: 'sla_sweep_interval_minutes',
            set_inbound_poll_interval: 'inbound_poll_interval_minutes',
            set_inbound_default_category: 'inbound_default_category'
        };
        Object.keys(map).forEach(elId => {
            const el = document.getElementById(elId);
            if (el && s[map[elId]] != null) el.value = s[map[elId]];
        });
        const boolMap = {
            set_auto_escalate: 'sla_auto_escalate',
            set_inbound_email_enabled: 'inbound_email_enabled'
        };
        Object.keys(boolMap).forEach(elId => {
            const el = document.getElementById(elId);
            if (el && s[boolMap[elId]] != null) el.value = String(s[boolMap[elId]]);
        });
        const emailEl = document.getElementById('set_email_enabled');
        if (emailEl && s.email_notifications_enabled != null) emailEl.value = s.email_notifications_enabled;
        this.loadAdmin2FA();
        this.loadIntegrations();
    }

    async saveSystemSettings() {
        const payload = {
            sla_response_high: document.getElementById('set_sla_response_high').value,
            sla_response_medium: document.getElementById('set_sla_response_medium').value,
            sla_response_low: document.getElementById('set_sla_response_low').value,
            sla_resolution_high: document.getElementById('set_sla_resolution_high').value,
            sla_resolution_medium: document.getElementById('set_sla_resolution_medium').value,
            sla_resolution_low: document.getElementById('set_sla_resolution_low').value,
            ticket_prefix: document.getElementById('set_ticket_prefix').value.trim(),
            site_name: document.getElementById('set_site_name').value.trim(),
            email_notifications_enabled: document.getElementById('set_email_enabled').value,
            sla_sweep_interval_minutes: document.getElementById('set_sla_sweep_interval').value,
            sla_auto_escalate: document.getElementById('set_auto_escalate').value,
            inbound_email_enabled: document.getElementById('set_inbound_email_enabled').value,
            inbound_poll_interval_minutes: document.getElementById('set_inbound_poll_interval').value,
            inbound_default_category: document.getElementById('set_inbound_default_category').value
        };
        try {
            await TicketAPI.updateSettings(payload);
            this.showToast('Settings saved.');
            await this.loadSystemSettings();
        } catch (error) {
            this.showToast(error.message || 'Failed to save settings.', true);
        }
    }

    // ============ Settings: Ticket Priority Rules ============
    // The rules themselves are developer-shaped: admins tune a rule's enabled
    // state, stop flag, resulting priority, order and condition *values* only.
    // The panel derives its allowed priorities from the server's meta so the
    // boundaries are never duplicated on the client.
    async loadPriorityRules() {
        const panel = document.getElementById('priorityRulesPanel');
        if (!panel) return;
        try {
            this.priorityRules = await TicketAPI.getPriorityRules();
            this.renderPriorityRules();
        } catch (error) {
            this.priorityRules = null;
            panel.innerHTML = `
                <div style="padding:16px;border:1px dashed var(--surface-muted, #e0e0e0);border-radius:10px;">
                    <p style="color:var(--text-muted, #8191a1);margin-bottom:10px;">Requires connection — priority rule configuration cannot be shown offline.</p>
                    <button type="button" class="btn-secondary btn-sm" onclick="app.loadPriorityRules()">${Icons.render('sync-alt')} Retry</button>
                </div>`;
        }
    }

    renderPriorityRules() {
        const panel = document.getElementById('priorityRulesPanel');
        if (!panel || !this.priorityRules) return;
        const cfg = this.priorityRules;
        const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
        panel.innerHTML = `
            <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;margin-bottom:15px;">
                <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                    <span class="priority-badge ${cfg.default_priority || 'medium'}">Fallback: ${this.capitalize(cfg.default_priority || 'medium')}</span>
                    <span style="font-size:0.8rem;color:var(--text-muted, #8191a1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;" title="Rule configuration version ${this._esc(cfg.version)}">v${this._esc(String(cfg.version).slice(0, 12))}${String(cfg.version).length > 12 ? '…' : ''}</span>
                    <span style="font-size:0.8rem;color:var(--text-muted, #8191a1);white-space:nowrap;">${rules.length} rule${rules.length === 1 ? '' : 's'}</span>
                </div>
                <button type="button" class="btn-secondary btn-sm" onclick="app.resetPriorityRules()">${Icons.render('undo')} Reset to defaults</button>
            </div>
            ${rules.length === 0
                ? '<p style="color:var(--text-muted, #8191a1);">No rules configured.</p>'
                : rules.map((rule, idx) => this.renderPriorityRuleCard(rule, idx, rules.length)).join('')}`;
    }

    renderPriorityRuleCard(rule, idx, total) {
        const allowed = (this.priorityRules.meta && this.priorityRules.meta.allowed_priorities) || ['low', 'medium', 'high'];
        const priorityOptions = allowed.map(p =>
            `<option value="${p}"${p === rule.resulting_priority ? ' selected' : ''}>${this.capitalize(p)}</option>`).join('');
        const conditionEditors = rule.condition.map((cond, ci) => this.renderConditionEditor(cond, idx, ci)).join('');
        const dim = rule.enabled ? '' : 'opacity:0.72;box-shadow:none;';
        return `
            <div style="border:1px solid var(--surface-muted, #e0e0e0);border-radius:10px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 2px rgba(0,0,0,0.06);${dim}" data-rule-idx="${idx}">
                <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;min-width:0;">
                    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0;">
                        <strong>${this._esc(rule.name)}</strong>
                        <code style="font-size:0.72rem;color:var(--text-muted, #8191a1);background:var(--surface-muted, #e0e0e0);padding:2px 6px;border-radius:4px;white-space:nowrap;">${this._esc(rule.rule_id)}</code>
                        <span style="font-size:0.8rem;color:var(--text-muted, #8191a1);white-space:nowrap;">${rule.enabled ? 'Active' : 'Disabled'}</span>
                    </div>
                    <div style="display:flex;gap:6px;align-items:center;">
                        <button type="button" class="btn-secondary btn-sm" aria-label="Move rule up" title="Move rule up" onclick="app.movePriorityRule(${idx}, -1)" ${idx === 0 ? 'disabled' : ''}>${Icons.render('chevron-up')}</button>
                        <button type="button" class="btn-secondary btn-sm" aria-label="Move rule down" title="Move rule down" onclick="app.movePriorityRule(${idx}, 1)" ${idx === total - 1 ? 'disabled' : ''}>${Icons.render('chevron-down')}</button>
                    </div>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:12px;">
                    <div class="form-group" style="flex:1 1 180px;min-width:0;">
                        <label for="prio-p-${rule.rule_id}">Resulting priority</label>
                        <select id="prio-p-${rule.rule_id}" data-k="priority">${priorityOptions}</select>
                    </div>
                    <div class="form-group" style="flex:1 1 180px;min-width:0;">
                        <label for="prio-e-${rule.rule_id}">Enabled</label>
                        <select id="prio-e-${rule.rule_id}" data-k="enabled">
                            <option value="true"${rule.enabled ? ' selected' : ''}>Enabled</option>
                            <option value="false"${rule.enabled ? '' : ' selected'}>Disabled</option>
                        </select>
                    </div>
                    <div class="form-group" style="flex:1 1 180px;min-width:0;">
                        <label for="prio-s-${rule.rule_id}">Stop after match</label>
                        <select id="prio-s-${rule.rule_id}" data-k="stop">
                            <option value="true"${rule.stop ? ' selected' : ''}>Stop (first match wins)</option>
                            <option value="false"${rule.stop ? '' : ' selected'}>Keep evaluating</option>
                        </select>
                    </div>
                </div>
                <div style="margin-top:12px;">
                    <label style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:6px;">Conditions (all must match)</label>
                    ${conditionEditors}
                </div>
                <div style="margin-top:12px;display:flex;justify-content:flex-end;">
                    <button type="button" class="btn-primary btn-sm" onclick="app.savePriorityRule(${idx})">${Icons.render('save')} Save changes</button>
                </div>
            </div>`;
    }

    renderConditionEditor(cond, idx, ci) {
        const chip = content => `<code style="font-size:0.72rem;color:var(--text-muted, #8191a1);background:var(--surface-muted, #e0e0e0);padding:2px 8px;border-radius:4px;overflow-wrap:anywhere;word-break:break-word;">${content}</code>`;
        let editor;
        if (cond.op === 'between') {
            const t0 = (cond.values && cond.values[0]) || '';
            const t1 = (cond.values && cond.values[1]) || '';
            editor = `
                <input type="time" aria-label="From time" value="${t0}" data-k="cond-${ci}-0" style="width:auto;">
                <span aria-hidden="true" style="color:var(--text-muted, #8191a1);">to</span>
                <input type="time" aria-label="To time" value="${t1}" data-k="cond-${ci}-1" style="width:auto;">`;
        } else {
            editor = `<input type="text" value="${this._esc(this._conditionValueText(cond))}" data-k="cond-${ci}" title="Separate values with commas: ${this._esc(this._conditionValueText(cond))}" style="min-width:0;flex:1 1 11rem;width:auto;max-width:100%;">`;
        }
        return `
            <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px;min-width:0;">
                ${chip(this._esc(cond.field))}${chip(this._esc(cond.op))}${editor}
            </div>`;
    }

    _conditionValueText(cond) {
        const list = Array.isArray(cond.values) && cond.values.length
            ? cond.values
            : (cond.value != null ? [cond.value] : []);
        return list.map(String).join(', ');
    }

    async savePriorityRule(idx) {
        const cfg = this.priorityRules;
        if (!cfg) return;
        const rule = cfg.rules[idx];
        if (!rule) return;
        const card = document.querySelector(`#priorityRulesPanel [data-rule-idx="${idx}"]`);
        if (!card) return;
        const changes = {
            enabled: card.querySelector('[data-k="enabled"]').value === 'true',
            stop: card.querySelector('[data-k="stop"]').value === 'true',
            resulting_priority: card.querySelector('[data-k="priority"]').value,
            condition: rule.condition.map((cond, ci) => {
                const next = { field: cond.field, op: cond.op };
                if (cond.op === 'between') {
                    next.values = [
                        card.querySelector(`[data-k="cond-${ci}-0"]`).value,
                        card.querySelector(`[data-k="cond-${ci}-1"]`).value
                    ];
                } else {
                    next.values = card.querySelector(`[data-k="cond-${ci}"]`).value
                        .split(',').map(s => s.trim()).filter(Boolean);
                }
                return next;
            })
        };
        const empty = changes.condition.some(c =>
            c.op === 'between'
                ? c.values.length !== 2 || !c.values[0] || !c.values[1]
                : c.values.length === 0);
        if (empty) {
            this.showToast('Each condition needs at least one value.', true);
            return;
        }
        try {
            await TicketAPI.updatePriorityRule(rule.rule_id, changes);
            this.showToast('Priority rule saved.');
            await this.loadPriorityRules();
        } catch (error) {
            this.showToast(error.message || 'Failed to save rule.', true);
        }
    }

    async movePriorityRule(idx, dir) {
        const cfg = this.priorityRules;
        if (!cfg) return;
        const ids = cfg.rules.map(r => r.rule_id);
        const j = idx + dir;
        if (j < 0 || j >= ids.length) return;
        [ids[idx], ids[j]] = [ids[j], ids[idx]];
        try {
            await TicketAPI.reorderPriorityRules(ids);
            this.showToast('Rule order saved.');
            await this.loadPriorityRules();
        } catch (error) {
            this.showToast(error.message || 'Failed to reorder rules.', true);
        }
    }

    async resetPriorityRules() {
        if (!confirm('Reset all priority rules to the developer defaults? Your current configuration will be lost.')) return;
        try {
            await TicketAPI.resetPriorityRules();
            this.showToast('Priority rules reset to defaults.');
            await this.loadPriorityRules();
        } catch (error) {
            this.showToast(error.message || 'Failed to reset rules.', true);
        }
    }

    // ============ Integrations: API tokens ============
    async loadIntegrations() {
        await this.loadTokens();
        await this.loadWebhooks();
        this.populateReset2FASelect();
    }

    async loadTokens() {
        const container = document.getElementById('tokenList');
        if (!container) return;
        container.innerHTML = '<p style="color:#999;">Loading...</p>';
        const tokens = await TicketAPI.getApiTokens();
        if (tokens.length === 0) {
            container.innerHTML = '<p style="color:#999;">No API tokens yet.</p>';
            return;
        }
        container.innerHTML = tokens.map(t => `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #f5f5f5;">
                <div>
                    <strong>${this._esc(t.name)}</strong>
                    <div style="font-size:0.8rem;color:#999;">
                        <code>${t.token_prefix}…</code> ·
                        ${t.is_active ? '<span class="status-badge open">Active</span>' : '<span class="status-badge resolved" style="background:#f5f5f5;color:#999;">Revoked</span>'}
                        ${t.expires_at ? ' · expires ' + new Date(t.expires_at).toLocaleDateString() : ''}
                    </div>
                </div>
                ${t.is_active ? `<button class="btn-danger btn-sm" onclick="app.revokeToken(${t.id})">${Icons.render('ban')} Revoke</button>` : ''}
            </div>
        `).join('');
    }

    async createToken() {
        const payload = {
            name: document.getElementById('tokenName').value.trim(),
            scopes: 'read'
        };
        const days = parseInt(document.getElementById('tokenDays').value, 10);
        if (days > 0) payload.expires_in_days = days;
        if (!payload.name) return;
        try {
            const result = await TicketAPI.createApiToken(payload);
            document.getElementById('newTokenBox').style.display = 'block';
            document.getElementById('newTokenValue').textContent = result.token;
            document.getElementById('tokenForm').reset();
            this.loadTokens();
        } catch (error) {
            this.showToast(error.message || 'Failed to create token.', true);
        }
    }

    async revokeToken(id) {
        try {
            await TicketAPI.revokeApiToken(id);
            this.showToast('Token revoked.');
            this.loadTokens();
        } catch (error) {
            this.showToast(error.message, true);
        }
    }

    copyToken() {
        const value = document.getElementById('newTokenValue').textContent;
        if (!value) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(value).then(() => this.showToast('Token copied to clipboard.'));
        } else {
            const ta = document.createElement('textarea');
            ta.value = value;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        }
    }

    // ============ Integrations: webhooks ============
    async loadWebhooks() {
        const container = document.getElementById('webhookList');
        if (!container) return;
        container.innerHTML = '<p style="color:#999;">Loading...</p>';
        const hooks = await TicketAPI.getWebhooks();
        if (hooks.length === 0) {
            container.innerHTML = '<p style="color:#999;">No webhooks configured.</p>';
            return;
        }
        container.innerHTML = hooks.map(w => `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #f5f5f5;">
                <div style="min-width:0;">
                    <strong>${this._esc(w.name)}</strong>
                    <div style="font-size:0.8rem;color:#999;word-break:break-all;"><code>${this._esc(w.url)}</code></div>
                    <div style="font-size:0.8rem;color:#999;">Events: <code>${this._esc(w.events || '—')}</code>${w.secret_masked ? ' · signed' : ''}</div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;">
                    <label style="font-size:0.8rem;display:flex;align-items:center;gap:5px;cursor:pointer;">
                        <input type="checkbox" ${w.is_active ? 'checked' : ''} onchange="app.toggleWebhook(${w.id}, this.checked)">
                        ${w.is_active ? 'On' : 'Off'}
                    </label>
                    <button class="btn-danger btn-sm" aria-label="Delete webhook" onclick="app.deleteWebhook(${w.id})">${Icons.render('trash')}</button>
                </div>
            </div>
        `).join('');
    }

    async createWebhook() {
        const payload = {
            name: '',
            url: document.getElementById('webhookUrl').value.trim(),
            events: document.getElementById('webhookEvents').value.trim() || 'ticket.created',
            secret: document.getElementById('webhookSecret').value.trim()
        };
        if (!payload.url) return;
        try {
            await TicketAPI.createWebhook(payload);
            this.showToast('Webhook added.');
            document.getElementById('webhookForm').reset();
            document.getElementById('webhookEvents').value = 'ticket.created,ticket.updated';
            this.loadWebhooks();
        } catch (error) {
            this.showToast(error.message, true);
        }
    }

    async toggleWebhook(id, active) {
        try {
            await TicketAPI.updateWebhook(id, { is_active: active });
            this.showToast(active ? 'Webhook enabled.' : 'Webhook paused.');
        } catch (error) {
            this.showToast(error.message, true);
        }
        this.loadWebhooks();
    }

    async deleteWebhook(id) {
        try {
            await TicketAPI.deleteWebhook(id);
            this.showToast('Webhook deleted.');
            this.loadWebhooks();
        } catch (error) {
            this.showToast(error.message, true);
        }
    }

    // ============ Settings: 2FA panel + reset ============
    async populateReset2FASelect() {
        const select = document.getElementById('reset2faUser');
        if (!select) return;
        if (!this.users || this.users.length === 0) {
            try {
                await this.loadUsers();
            } catch (error) {
                return;
            }
        }
        select.innerHTML = '<option value="">Choose a user...</option>' +
            (this.users || []).map(u => `<option value="${u.id}">${this._esc(u.username)}</option>`).join('');
    }

    async loadAdmin2FA() {
        const panel = document.getElementById('admin2FAPanel');
        if (!panel) return;
        let status;
        try {
            status = await TicketAPI.get2FAStatus();
        } catch (error) {
            panel.innerHTML = '<p style="color:#999;">Could not load 2FA status.</p>';
            return;
        }
        if (status.enabled) {
            panel.innerHTML = `
                <p style="margin-bottom:12px;"><span class="status-badge open" style="display:inline-block;">2FA enabled on your account</span></p>
                <input type="text" id="admin2FADisableCode" inputmode="numeric" maxlength="6" placeholder="Enter current code to disable"
                    style="padding:8px 10px;border:1px solid #ddd;border-radius:6px;min-width:240px;margin-right:8px;">
                <button class="btn-secondary btn-sm" id="admin2FADisableBtn">Disable</button>
            `;
            document.getElementById('admin2FADisableBtn').addEventListener('click', async () => {
                try {
                    await TicketAPI.disable2FA(document.getElementById('admin2FADisableCode').value.trim());
                    this.showToast('Two-factor authentication disabled.');
                    this.loadAdmin2FA();
                } catch (error) {
                    this.showToast(error.message, true);
                }
            });
        } else {
            panel.innerHTML = `
                <p style="font-size:0.85rem;color:#999;margin-bottom:12px;">Two-factor authentication is off for this admin account.</p>
                <button class="btn-primary btn-sm" id="admin2FAEnableBtn">${Icons.render('shield-alt')} Enable</button>
                <div id="admin2FASetup" style="display:none;margin-top:14px;"></div>
            `;
            document.getElementById('admin2FAEnableBtn').addEventListener('click', async () => {
                try {
                    const setup = await TicketAPI.setup2FA();
                    const host = document.getElementById('admin2FASetup');
                    host.style.display = 'block';
                    host.innerHTML = `
                        <p style="font-size:0.85rem;color:#999;margin-bottom:10px;">
                            Scan this QR code with your authenticator app. Secret: <code>${setup.secret}</code>
                        </p>
                        <div id="admin2faQr" style="margin-bottom:12px;"></div>
                        <input type="text" id="admin2faCode" inputmode="numeric" maxlength="6" placeholder="6-digit code"
                            style="padding:8px 10px;border:1px solid #ddd;border-radius:6px;min-width:200px;margin-right:8px;letter-spacing:0.3em;">
                        <button class="btn-primary btn-sm" id="admin2faVerifyBtn">Activate</button>
                    `;
                    if (window.QRCode) {
                        new QRCode(document.getElementById('admin2faQr'), { text: setup.otpauth_uri, width: 150, height: 150 });
                    }
                    document.getElementById('admin2faVerifyBtn').addEventListener('click', async () => {
                        try {
                            await TicketAPI.verify2FASetup(document.getElementById('admin2faCode').value.trim());
                            this.showToast('Two-factor authentication enabled!');
                            this.loadAdmin2FA();
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

    // ============ Announcements ============
    async sendBroadcast() {
        const payload = {
            title: document.getElementById('broadcastTitle').value.trim(),
            message: document.getElementById('broadcastMessage').value.trim(),
            role: document.getElementById('broadcastRole').value
        };
        if (!payload.message) return;
        try {
            const result = await TicketAPI.broadcastNotification(payload);
            this.showToast(`Broadcast sent to ${result.count} user(s).`);
            document.getElementById('broadcastForm').reset();
        } catch (error) {
            this.showToast(error.message || 'Failed to send broadcast.', true);
        }
    }

    showToast(message, isError = false) {
        const toast = document.createElement('div');
        toast.className = 'toast' + (isError ? ' error' : '');
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    // ============ SLA helpers ============
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

    // ============ Audit Log ============
    async loadAuditLogs() {
        const entity = document.getElementById('auditEntityFilter').value;
        const container = document.getElementById('auditLogBody');
        if (!container) return;
        container.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:30px;color:#999;">' + Icons.render('spinner', { state: 'loading' }) + ' Loading...</td></tr>';

        const logs = await TicketAPI.getAuditLogs(entity);
        if (logs.length === 0) {
            container.innerHTML = '<tr><td colspan="6"><div class="empty-state">' + Icons.render('history') + '<p>No audit log entries found.</p></div></td></tr>';
            return;
        }

        const showDetails = this.auditShowDetails;
        container.innerHTML = logs.map(l => `
            <tr>
                <td style="white-space:nowrap;">${new Date(l.created_at).toLocaleString()}</td>
                <td><strong>${this.capitalize(l.actor)}</strong></td>
                <td><span class="status-badge open">${this.capitalize(l.action.replace(/_/g, ' '))}</span></td>
                <td>${this.capitalize(l.entity_type)}</td>
                <td>${l.entity_id ? '<code style="font-size:0.8rem;">' + l.entity_id + '</code>' : '—'}</td>
                <td style="max-width:320px;">${showDetails && l.details ? '<span style="font-size:0.8rem;color:#555;">' + l.details + '</span>' : '&middot;'}</td>
            </tr>
        `).join('');
    }

    toggleAuditDetails() {
        this.auditShowDetails = !this.auditShowDetails;
        this.loadAuditLogs();
    }

    capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }
}

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
        var expanded = small ? drawerOpen : (!wide ? expandedOverlay : remembered === 'expanded');
        var btn = document.getElementById('toggleSidebar');
        var btnMobile = document.getElementById('toggleSidebarMobile');
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
            var detailModal = document.getElementById('ticketDetailModal');
            if (detailModal && detailModal.style.display === 'block') {
                detailModal.style.display = 'none';
            }
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

    // KaiOS D-pad focus pass (§13.10). No CSS can bring the cell under
    // focus into view inside an overflow-x:auto container — this is the
    // one affordance that must be JS. Delegated on document so it survives
    // every table re-render and the modal portals, and it does not compete
    // with the Escape-keydown handler above (different event, different key).
    // 'nearest' only: never jumps the table horizontally away from the row
    // the D-pad already reached.
    document.addEventListener('focusin', function (e) {
        var cell = e.target;
        if (!cell || cell.nodeType !== 1) return;
        var container = cell.closest('.table-container');
        if (container && cell.scrollIntoView) {
            cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    });
});
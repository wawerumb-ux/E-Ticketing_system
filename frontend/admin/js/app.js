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
// Fallback display labels per notification category (used when the shared
// NotificationPrefs registry is unavailable, e.g. offline/uncached). Live
// labels come from the server registry via NotificationPrefs.getRegistry().
const NOTIFICATION_CATEGORY_LABELS = {
    'ticket_updates': 'Ticket updates',
    'technician_replies': 'Replies',
    'announcements': 'Announcements',
    'sla_breaches': 'SLA'
};
const NOTIFICATION_CATEGORY_ORDER = ['ticket_updates', 'technician_replies', 'announcements', 'sla_breaches'];
const NOTIFICATION_STATE_TABS = [
    { key: 'open', label: 'Open' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'resolved', label: 'Resolved' },
    { key: 'sla_breached', label: 'SLA' }
];
// Disabled notification categories hide their bell state tabs and the
// matching dashboard stat cards. Notifications of the disabled category are
// already filtered out of the list; this keeps the tab bar and dashboard
// honest with them.
const NOTIFICATION_STATE_TAB_CATEGORY = {
    open: 'ticket_updates',
    in_progress: 'ticket_updates',
    resolved: 'ticket_updates',
    sla_breached: 'sla_breaches'
};
// Only SLA cards are mapped on the dashboard (admin decision): turning off
// SLA breaches hides both SLA breach stat cards. Ticket-status cards stay.
const DASHBOARD_CATEGORY_CARDS = {
    'sla_breaches': [
        '.stat-card[data-drill="sla_response"]',
        '.stat-card[data-drill="sla_resolution"]'
    ]
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
        // The dialog's two views, in arrow order. Adding a view here is all it
        // takes: the arrows, the label and the focus handling read from these.
        this.syncing = false;
        this.notifications = [];
        this.notificationUnread = 0;
        this.notificationsOffline = false;
        this.notificationFilter = 'all';
        this._dialogOpener = null;
        this.init();
    }

    async init() {
        this.applyTheme();
        this.setupOfflineSync();
        window.showToast = (message, type) => this.showToast(message, type === 'error');
        this.setupAccountDialog();
        this.setupProfileModal();
        this.setupAccountInfoCard();
        this.setupPictureDialog();
        this.setupChangePasswordModal();
        this.setupEventListeners();
        await this.loadNotificationPrefs();
        this.renderIdentity();
        await this.loadUsers();
        await this.loadTickets();
        // Dashboard loads through the section router (renderSection), so a
        // reload on a deep hash (#/users, #/audit, ...) does not fetch stats
        // the user is not looking at. initSectionRouting renders once here.
        this.setupLiveEvents();
        this.initSessionExpiredDialog();
        this.initSectionRouting();
        this.loadNotifications();
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
        LiveEvents.on('comment.created', () => this.loadNotifications());
        LiveEvents.on('ticket.updated', () => this.loadNotifications());
        LiveEvents.on('announcement', () => this.loadNotifications());
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
            this._closeDialog(document.getElementById('userDetailModal'));
        });

        document.getElementById('userDetailEditBtn').addEventListener('click', () => {
            this._closeDialog(document.getElementById('userDetailModal'));
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
            this._closeDialog(document.getElementById('userDetailModal'));
        });

        // Escape closes the technician dialog, and Tab stays trapped inside it
        // while it is open (MOD5). Kept separate from the notification
        // dropdown's own Escape handler so neither can swallow the other.
        const userDetailModal = document.getElementById('userDetailModal');
        userDetailModal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                this._closeDialog(userDetailModal);
                return;
            }
            this._trapDialogFocus(e, userDetailModal);
        });

        // The ticket table is re-rendered on every load, so the assignee
        // avatar's click is delegated from the table body instead of being
        // rebound to each row.
        document.getElementById('ticketTableBody').addEventListener('click', (e) => {
            const trigger = e.target.closest('[data-assignee]');
            if (!trigger) return;
            this.openAssigneeDetail(trigger.dataset.assignee);
        });

        // A photo can 404 (removed on another device, storage volume lost).
        // 'error' does not bubble, so this listens in the capture phase, and
        // the disc degrades to the monogram instead of showing a broken-image
        // icon (OFF4).
        document.getElementById('ticketTableBody').addEventListener('error', (e) => {
            const img = e.target;
            if (!img.classList || !img.classList.contains('assignee-avatar-img')) return;
            const initial = img.dataset.initial || '';
            img.remove();
            const disc = img.parentElement;
            if (disc && !disc.textContent.trim()) disc.textContent = initial;
        }, true);

        // Same degradation for the Users table, which uses a different disc
        // class, so it needs its own listener.
        document.getElementById('userTableBody').addEventListener('error', (e) => {
            const img = e.target;
            if (!img.classList || !img.classList.contains('user-avatar-img')) return;
            const initial = img.dataset.initial || '';
            img.remove();
            const disc = img.parentElement;
            if (disc && !disc.textContent.trim()) disc.textContent = initial;
        }, true);

        // A ticket in the technician dialog opens the ticket, but the
        // technician dialog is closed first so the two dialogs never stack.
        document.getElementById('userDetailAssignedTickets')
            .addEventListener('click', (e) => {
                const trigger = e.target.closest('[data-ticket-id]');
                if (!trigger) return;
                this._closeDialog(document.getElementById('userDetailModal'));
                this.openTicketDetail(parseInt(trigger.dataset.ticketId, 10));
            });

        // Technician photo upload. The input is display:none and opened by the
        // button, which is why it carries its own aria-label.
        const avatarFile = document.getElementById('userDetailAvatarFile');
        document.getElementById('userDetailAvatarBtn').addEventListener('click', () => {
            avatarFile.value = '';
            avatarFile.click();
        });
        avatarFile.addEventListener('change', async () => {
            const file = avatarFile.files && avatarFile.files[0];
            if (!file) return;
            try {
                const updated = await uploadAvatar(this.activeDetailUserId, file);
                this.mergeUser(updated);
                this.renderUserDetailTickets(updated);
                this.openUserDetail(updated.id);
                this.renderTickets(this.filteredTickets);
                this.showToast('Photo updated.');
            } catch (err) {
                this.showToast(err.message || 'Could not upload the photo.', true);
            }
        });
        document.getElementById('userDetailAvatarRemoveBtn').addEventListener('click', async () => {
            try {
                const updated = await deleteAvatar(this.activeDetailUserId);
                this.mergeUser(updated);
                this.openUserDetail(updated.id);
                this.renderTickets(this.filteredTickets);
                this.showToast('Photo removed.');
            } catch (err) {
                this.showToast(err.message || 'Could not remove the photo.', true);
            }
        });

        // Emoji fallback, for a technician with no photo to upload. A photo and
        // an emoji are mutually exclusive server-side, so picking one and
        // uploading the other each replace the other cleanly.
        const emojiPanel = document.getElementById('userDetailEmojiPanel');
        const emojiToggle = document.getElementById('userDetailEmojiBtn');
        const closeEmojiPanel = () => {
            emojiPanel.hidden = true;
            emojiToggle.setAttribute('aria-expanded', 'false');
        };
        emojiToggle.addEventListener('click', () => {
            const opening = emojiPanel.hidden;
            emojiPanel.hidden = !opening;
            emojiToggle.setAttribute('aria-expanded', String(opening));
        });
        // Rendered once: the list is static, and rebuilding it on every open
        // would drop keyboard focus back to the top of the dialog.
        if (window.EmojiPicker) {
            window.EmojiPicker.render(
                document.getElementById('userDetailEmojiChoices'),
                async (emoji) => {
                    try {
                        const updated = await setAvatarEmoji(this.activeDetailUserId, emoji);
                        this.mergeUser(updated);
                        this.renderUserDetailTickets(updated);
                        this.openUserDetail(updated.id);
                        this.renderTickets(this.filteredTickets);
                        this.showToast('Emoji avatar set.');
                    } catch (err) {
                        this.showToast(err.message || 'Could not set the emoji.', true);
                    }
                });
        } else {
            // The picker is local markup, so this only happens if the script
            // failed to load. Hide the button rather than offer a dead control.
            emojiToggle.style.display = 'none';
        }
        document.getElementById('userDetailEmojiClearBtn').addEventListener('click', async () => {
            try {
                const updated = await clearAvatarEmoji(this.activeDetailUserId);
                this.mergeUser(updated);
                this.openUserDetail(updated.id);
                this.renderTickets(this.filteredTickets);
                this.showToast('Emoji cleared.');
            } catch (err) {
                this.showToast(err.message || 'Could not clear the emoji.', true);
            }
        });
        // Escape closes the panel before the dialog itself, so one keypress
        // does not throw away the whole dialog.
        document.getElementById('userDetailModal').addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !emojiPanel.hidden) {
                e.stopPropagation();
                closeEmojiPanel();
                emojiToggle.focus();
            }
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

        document.getElementById('notificationBell').addEventListener('click', () => this.toggleNotificationDropdown());

        window.addEventListener('click', (e) => {
            const bell = document.getElementById('notificationBell');
            const dropdown = document.getElementById('notificationDropdown');
            if (dropdown && dropdown.style.display === 'block' && !bell.contains(e.target) && !dropdown.contains(e.target)) {
                dropdown.style.display = 'none';
                bell.setAttribute('aria-expanded', 'false');
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const bell = document.getElementById('notificationBell');
            const dropdown = document.getElementById('notificationDropdown');
            if (dropdown && dropdown.style.display === 'block') {
                dropdown.style.display = 'none';
                if (bell) {
                    bell.setAttribute('aria-expanded', 'false');
                    bell.focus();
                }
            }
        });

        document.addEventListener('notification-prefs:changed', () => {
            this.refreshNotificationCounts();
            this.renderNotificationStateTabs();
            this.renderNotificationList();
            if (this.currentSection === 'dashboard') this.applyDashboardCategoryVisibility();
        });

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

        document.getElementById('addNotificationCategoryForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleAddNotificationCategory();
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
        if (!container) return Promise.resolve();
        if (typeof window.NotificationPrefs === 'undefined') {
            container.innerHTML = '<div class="pref-offline"><strong>Not available</strong><p>Notification preferences could not be loaded right now.</p></div>';
            return Promise.resolve();
        }
        return window.NotificationPrefs.render(container);
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
        await this.warmNotificationRegistry();
        this.refreshNotificationCounts();
        this.renderNotificationStateTabs();
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

    async warmNotificationRegistry() {
        if (typeof window.NotificationPrefs === 'undefined') return;
        if (navigator.onLine === false) return;
        if (window.NotificationPrefs.getRegistry()) return;
        try {
            await window.NotificationPrefs.load();
        } catch (e) { /* labels fall back to NOTIFICATION_CATEGORY_LABELS */ }
    }

    saveNotificationsCache() {
        try {
            if (typeof OfflineDB === 'undefined' || !OfflineDB.cachePut) return;
            OfflineDB.cachePut('ntf_cache', {
                notifications: this.notifications,
                unread_count: this.notificationUnread
            }, this._offlineUser());
        } catch (e) { /* storage unavailable: offline rendering degrades gracefully */ }
    }

    async loadNotificationsCache() {
        try {
            if (typeof OfflineDB === 'undefined' || !OfflineDB.cacheGet) return null;
            const record = await OfflineDB.cacheGet('ntf_cache');
            if (!record || !record.data) return null;
            const expectedUser = this._offlineUser();
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

        const visible = this.visibleNotifications();
        let filtered;
        if (this.notificationFilter === 'read') {
            filtered = visible.filter(n => n.is_read);
        } else if (this.notificationFilter === 'all') {
            filtered = visible;
        } else {
            filtered = visible.filter(n => n.state === this.notificationFilter);
        }
        if (filtered.length === 0) {
            container.innerHTML = this.renderEmptyState(visible);
            this.renderLastSynced();
            return;
        }
        container.innerHTML = this.renderNotificationGroups(filtered);
        this.renderLastSynced();
    }

    renderEmptyState(visible) {
        const visibleCount = visible ? visible.length : this.visibleNotifications().length;
        if (this.notificationFilter === 'all' && visibleCount > 0 && this.notifications.length > 0) {
            return `
                <div class="empty-state" style="padding:20px;">
                    ${Icons.render('check-circle')}
                    <p>You're all caught up.</p>
                </div>
            `;
        }
        if (this.notificationFilter !== 'all' && visibleCount > 0) {
            return `
                <div class="empty-state" style="padding:20px;">
                    ${Icons.render('check-circle')}
                    <p>Nothing here.</p>
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

    renderNotificationStateTabs() {
        const host = document.getElementById('notificationStateTabs');
        if (!host) return;
        if (typeof window.NotificationPrefs !== 'undefined' && this.notificationFilter in NOTIFICATION_STATE_TAB_CATEGORY &&
            !window.NotificationPrefs.isCategoryEnabled(NOTIFICATION_STATE_TAB_CATEGORY[this.notificationFilter])) {
            this.notificationFilter = 'all';
            this.renderNotificationList();
        }
        const visible = this.visibleNotifications();
        const counts = {};
        visible.forEach(n => {
            if (n.state) counts[n.state] = (counts[n.state] || 0) + 1;
        });
        const tabs = NOTIFICATION_STATE_TABS.filter(tab => {
            const cid = NOTIFICATION_STATE_TAB_CATEGORY[tab.key];
            if (!cid || typeof window.NotificationPrefs === 'undefined') return true;
            return window.NotificationPrefs.isCategoryEnabled(cid);
        });
        host.innerHTML = tabs.map(tab => {
            const count = counts[tab.key] || 0;
            return `
                <button type="button" class="notification-tab" aria-pressed="${String(this.notificationFilter === tab.key)}" data-filter="${tab.key}" onclick="app.setNotificationFilter('${tab.key}')">${this._esc(tab.label)}<span class="notification-tab-count" aria-hidden="true">${count}</span></button>
            `;
        }).join('');
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
            const msg = this._esc(n.message);
            const tip = this._esc(n.link ? `${n.message} — view ticket` : n.message);
            return `
                <button type="button" class="notification-item ${n.is_read ? '' : 'unread'}" aria-label="${msg}" title="${tip}" onclick="app.onNotificationClick(${n.id})">
                    <span class="notification-type-icon" aria-hidden="true">${Icons.render(this.notificationIcon(n.type))}</span>
                    <span class="notification-item-text">
                        <span class="notification-item-msg">${msg}</span>
                        <span class="notification-item-time">${this._esc(this.friendlyTime(n.created_at))}</span>
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
        // Shares the card's renderer, so the sidebar and the profile dialog can
        // never disagree about which avatar is current.
        if (avatarEl) this._fillAvatarDisc(avatarEl, eff.avatar, eff.avatarEmoji, name.charAt(0).toUpperCase());
    }

    // ============ Admin identity menu (account + user-management launcher) ============
    // Superset of the user portal's identity block: same avatars/name/role slots,
    // extended with inline account + user-management actions. Offline-first: all
    // items are either routes/modals that already exist client-side, or are
    // disabled with a visible TODO (no invented backend endpoints).
    // Every item is either a route/modal that already exists client-side, or is
    // disabled with a visible TODO (no invented backend endpoints).
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

        // Escape closes the card and Tab stays trapped inside it (MOD5). The
        // cards stacked on top of this one are siblings with their own
        // handlers, so they unwind before it.
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                this._closeDialog(modal);
                return;
            }
            this._trapDialogFocus(e, modal);
        });

        // Backdrop click closes. The click is matched on the overlay itself so
        // it cannot fire from inside the sheet (which would close the dialog
        // while the user is typing in the find field).
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

        // Actions close the dialog first, then open their target, so only one
        // dialog is ever on screen. That is the order the dropdown used.
        // The hero avatar is the only picture trigger: it opens the picture
        // dialog as a sibling overlay, so no popover is anchored to a button.
        // Both avatars open the same picture card: the profile card's hero, and
        // the one in the Account Information card (whose hero is behind the
        // backdrop and cannot be reached).
        // The camera badge is the reference design's second trigger for the
        // same action, so both land on the picture options card.
        ['accountHeroAvatarBtn', 'adminInfoAvatarBtn', 'adminInfoCamBadge'].forEach((id) => {
            const btn = document.getElementById(id);
            if (btn) btn.addEventListener('click', () => this.openPictureDialog());
        });

        // Each target card closes this one itself, so only one card is ever on
        // screen. Both are siblings, never mixed into this card's body.
        document.getElementById('acctViewProfile').addEventListener('click', () => this.openAccountInfoCard());
        document.getElementById('acctChangePassword').addEventListener('click', () => this.openChangePasswordModal());
        document.getElementById('acctLogout').addEventListener('click', () => AuthAPI.logout());
    }

    // TODO: "View profile" (own profile route) and "Change password"
    // (password-change modal) have no backend route yet — keep them disabled.
    // ============ Admin profile helpers ============
    // The avatar is server-backed (User.avatar_url / User.avatar_emoji), the same
    // source the Users table and the technician dialog read, so one account can
    // no longer show two different faces. Only the display name is still local:
    // there is no display_name column and no route to write one (see S2).
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
            // avatarUrl(), not the raw column: an <img> request cannot carry an
            // Authorization header, so the access token has to ride in the query
            // string or the photo 401s and the disc falls back to a monogram.
            // The legacy local dataUrl is kept only as a fallback so an account
            // that set a picture before the server-backed avatar existed does not
            // silently lose it. Any server write clears it (see handleAdminAvatarFile).
            avatar: avatarUrl(user) || local.avatar || '',
            avatarEmoji: user.avatar_emoji || ''
        };
    }

    // Writes an updated user record back into both caches that read it: the
    // loaded users list and the sessionStorage identity that renderIdentity()
    // and openAccountInfoCard() depend on.
    _syncSelfUser(updated) {
        if (!updated || updated.id == null) return;
        this.mergeUser(updated);
        const me = AuthAPI.getCurrentUser();
        if (me && me.id === updated.id) {
            try {
                sessionStorage.setItem('current_user', JSON.stringify(
                    Object.assign({}, me, updated)));
            } catch (e) { /* the in-memory users list is still updated */ }
        }
    }

    _esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // ---- Dialog open/close with focus handling (MOD5) ----
    // Scoped to the user detail dialog. The remaining dialogs still toggle
    // display directly; retrofitting all of them at once is a separate change.
    // focusEl overrides the "first focusable" default, for cards whose first
    // control is navigation rather than the thing to type into.
    _openDialog(modal, focusEl) {
        if (!modal) return;
        // Remember the trigger so focus can go back to it on close. Without
        // this a keyboard user is dropped at the top of the document.
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

    // Keep Tab inside the dialog. Modal overlays cover the page but do not
    // inert it, so without this the keyboard walks straight into content
    // that is visually behind the backdrop.
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

    // Pick a stable tint for an assignee from their username, so the same
    // technician is always the same colour without storing anything. The four
    // families mirror the badge tokens, which keeps the palette on-theme.
    _assigneeVariant(username) {
        const s = String(username || '');
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return ['av-primary', 'av-success', 'av-warning', 'av-danger'][h % 4];
    }

    assigneeCell(username) {
        const name = String(username == null ? '' : username).trim();
        if (!name) {
            return '<span class="assignee-name assignee-unassigned">Unassigned</span>';
        }
        // The disc opens the technician's detail dialog, so it is a real
        // control and needs an accessible name. The username sits beside it as
        // plain text, so it stays out of the button's name to avoid a double
        // announcement.
        const user = this.users.find(u => u.username === name);
        const photo = avatarUrl(user);
        // Three states, in precedence order: photo, chosen emoji, then the
        // username monogram. Exactly one is drawn, so the disc is never
        // showing two identities at once.
        const emoji = photo ? '' : (user && user.avatar_emoji ? user.avatar_emoji : '');
        // The image is decorative: the button's aria-label already names the
        // technician, so an alt text here would be announced twice.
        let visual;
        if (photo) {
            visual = `<img class="assignee-avatar-img" src="${this._esc(photo)}" alt="" data-initial="${this._esc(name.charAt(0).toUpperCase())}">`;
        } else if (emoji) {
            visual = `<span class="assignee-avatar-emoji" aria-hidden="true">${this._esc(emoji)}</span>`;
        } else {
            visual = this._esc(name.charAt(0).toUpperCase());
        }
        return `<span class="assignee-cell">`
             + `<button type="button" class="assignee-avatar ${this._assigneeVariant(name)}"`
             + ` data-assignee="${this._esc(name)}"`
             + ` aria-label="View technician details for ${this._esc(name)}">`
             + `${visual}</button>`
             + `<span class="assignee-name">${this._esc(name)}</span>`
             + `</span>`;
    }

    // Tickets record assigned_to as a username, while the detail dialog is
    // keyed by user id, so resolve one to the other before opening it.
    openAssigneeDetail(username) {
        const name = String(username == null ? '' : username).trim();
        if (!name) return;
        const user = this.users.find(u => u.username === name);
        if (!user) {
            this.showToast(`No staff record for @${name}.`, true);
            return;
        }
        this.openUserDetail(user.id);
    }

    // Tickets in the client-side list that this technician owns, newest first.
    // assigned_to holds a username, so the match is on that exact string.
    assignedTicketsFor(username) {
        const name = String(username == null ? '' : username).trim();
        if (!name) return [];
        return this.tickets
            .filter(t => String(t.assigned_to == null ? '' : t.assigned_to).trim() === name)
            .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    }

    renderUserDetailTickets(user) {
        const container = document.getElementById('userDetailAssignedTickets');
        if (!container) return;
        const assigned = this.assignedTicketsFor(user.username);
        if (assigned.length === 0) {
            container.innerHTML = '<p class="user-detail-empty">No tickets assigned.</p>';
            return;
        }
        container.innerHTML = assigned.map(t => {
            const status = String(t.status || '');
            const label = this.capitalize(status.replace('_', ' '));
            // Left as a plain button: putting role="listitem" on it would
            // override the button role and stop it being announced as
            // activatable. The container is the labelled group instead.
            return '<button type="button" class="user-detail-ticket"'
                 + ` data-ticket-id="${this._esc(t.id)}"`
                 + ` title="${this._esc(t.title || '')}">`
                 + `<span class="user-detail-ticket-id">${this._esc(t.ticket_number || `#${t.id}`)}</span>`
                 + `<span class="user-detail-ticket-title">${this._esc(t.title || 'Untitled')}</span>`
                 + `<span class="status-badge ${this._esc(status)}">${this._esc(label)}</span>`
                 + '</button>';
        }).join('');
    }

    // ============ Account dialog (replaces the identity dropdown) ============
    // One click on the sidebar identity block opens a dialog that shows who is
    // signed in plus every action the dropdown used to carry. The dialog is
    // populated from already-cached state, so it renders with no network call
    // (OFF1); the /me refresh that openAccountInfoCard does is not repeated here
    // because this card is a read-only summary of the same record.
    openAccountDialog() {
        const modal = document.getElementById('accountModal');
        if (!modal) return;

        const eff = this.getEffectiveProfile();
        const name = eff.displayName || eff.username || 'Admin';
        const nameEl = document.getElementById('accountModalName');
        const roleEl = document.getElementById('accountModalRole');
        if (nameEl) nameEl.textContent = name;
        if (roleEl) {
            const label = eff.role
                ? eff.role.charAt(0).toUpperCase() + eff.role.slice(1)
                : 'Administrator';
            roleEl.textContent = label;
            // Same tint-and-ink family the badge already had, so swapping the
            // text cannot change its contrast (BLD2).
            roleEl.className = 'role-badge ' + (eff.role === 'admin' ? 'admin' : 'staff');
        }
        // The hero avatar IS the profile preview element, so the two can never
        // disagree about which picture is current.
        const avatarEl = document.getElementById('adminProfileAvatarPreview');
        if (avatarEl) this._fillAvatarDisc(avatarEl, eff.avatar, eff.avatarEmoji, name.charAt(0).toUpperCase());

        this._renderAccountInfoRows(eff);
        this._openDialog(modal);
    }

    // Read-only detail rows. Username is shown as the handle because it is the
    // immutable identifier every other table references (AGENTS 1.3).
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
                <dt>${this._esc(label)}</dt>
                <dd class="${value === dash ? '' : 'is-strong'}">${value}</dd>
            </div>
        `).join('');
    }


    // The reference's syncIdentity(): the name in the identity column is the
    // same string the form is being edited for, so the two can never disagree
    // while it is being typed into.
    _syncProfileIdentity() {
        const nameField = document.getElementById('adminProfileDisplayName');
        const userField = document.getElementById('adminProfileUsername');
        const fallback = (AuthAPI.getCurrentUser() || {}).username || 'admin';
        if (nameField) {
            const shown = nameField.value.trim() || 'Your name';
            const hero = document.getElementById('adminProfileHeroName');
            if (hero) hero.textContent = shown;
            const chip = document.getElementById('adminPreviewSidebarName');
            if (chip) chip.textContent = shown;
        }
        if (userField) {
            const handle = document.getElementById('adminProfileHandle');
            if (handle) handle.textContent = '@' + (userField.value.trim() || fallback);
        }
    }

    // ============ Admin profile modal (View profile) ============
    // Paint the profile body from a given identity. Deliberately synchronous:
    // every value it needs is already in hand, so the form has real content on
    // the first frame instead of a blank sheet.
    _renderProfileBody(eff) {
        const user = AuthAPI.getCurrentUser() || {};
        const initial = (eff.displayName || eff.username || 'A').charAt(0).toUpperCase();

        document.getElementById('adminProfileDisplayName').value = eff.displayName || '';
        document.getElementById('adminProfilePhone').value = eff.phone || '';
        document.getElementById('adminProfileEmail').value = eff.email || '';
        document.getElementById('adminProfileUsername').value = eff.username || user.username || '';
        // The role appears twice, as the reference has it: as the tag in the
        // identity column and as a readonly row in the form.
        const roleValue = eff.role || user.role || 'admin';
        const roleText = roleValue.charAt(0).toUpperCase() + roleValue.slice(1);
        const roleTag = document.getElementById('adminProfileRole');
        if (roleTag) roleTag.textContent = roleText;
        const roleField = document.getElementById('adminProfileRoleField');
        if (roleField) roleField.value = roleText;

        // The identity column mirrors the live form, as the reference's
        // syncIdentity() does: the name it shows is the name being edited, so
        // the two cannot drift apart mid-typing.
        this._syncProfileIdentity();
        const heroRole = document.getElementById('accountModalRole');
        if (heroRole) {
            heroRole.textContent = roleText;
        }

        this._renderAdminAvatarPreview(eff.avatar, eff.avatarEmoji, initial);
        this._syncAdminAvatarButtons(eff.avatar, eff.avatarEmoji);
        this._renderAdminPreview(eff, initial);
        this._setProfileUnsaved(false);

        this.populateDepartmentSelects().then(() => {
            const sel = document.getElementById('adminProfileDepartment');
            if (sel && eff.department) sel.value = eff.department;
        });

    }

    // The rail previews the three surfaces the signed-in admin's avatar really
    // appears on. Every one of them is rendered from the same precedence as the
    // live surface (photo, then emoji, then initials), so the preview cannot
    // drift from what the user will actually see.
    _renderAdminPreview(eff, initial) {
        const name = eff.displayName || eff.username || 'admin';
        const sidebarName = document.getElementById('adminPreviewSidebarName');
        if (sidebarName) sidebarName.textContent = name;

        const sidebarDisc = document.getElementById('adminPreviewSidebarAvatar');
        if (sidebarDisc) this._fillAvatarDisc(sidebarDisc, eff.avatar, eff.avatarEmoji, initial);

        // The ticket row only exists if the admin is genuinely an assignee on a
        // ticket. When they are not, say so rather than inventing a ticket
        // number (S2).
        const ticket = this.tickets.find(t => t.assigned_to === eff.username);
        const ticketName = document.getElementById('adminPreviewTicketName');
        const ticketSub = document.getElementById('adminPreviewTicketSub');
        const ticketDisc = document.getElementById('adminPreviewTicketAvatar');
        if (ticketName) ticketName.textContent = ticket ? (ticket.ticket_number || name) : 'No assigned tickets';
        if (ticketSub) ticketSub.textContent = ticket ? 'As a ticket assignee' : 'As a ticket assignee';
        if (ticketDisc) {
            if (ticket) {
                this._fillAvatarDisc(ticketDisc, eff.avatar, eff.avatarEmoji, initial);
            } else {
                ticketDisc.textContent = '';
                ticketDisc.classList.remove('has-emoji');
            }
        }
    }

    // ============ Cards layered over the page ============
    // The picture options are the one card that opens *on top of* another card
    // (the Account Information card), so they need the opener bookkeeping below.
    // The Account Information card instead replaces the profile card, so it uses
    // the plain _openDialog/_closeDialog pair.
    //
    // _openDialog keeps its trigger in one shared slot, which a stacked overlay
    // would otherwise overwrite and cost the card underneath its focus return.
    // The overlay parks that slot here and hands it back on close (MOD5).
    _openStackedCard(modalId, slot) {
        const modal = document.getElementById(modalId);
        if (!modal) return null;
        this[slot] = this._dialogOpener || document.activeElement;
        this._openDialog(modal);
        return modal;
    }

    // fallbackId is only used if the trigger has gone from the document.
    _closeStackedCard(modalId, slot, fallbackId) {
        const modal = document.getElementById(modalId);
        if (!modal) return;
        const opener = this[slot];
        this._closeDialog(modal);
        this._dialogOpener = opener || null;
        this[slot] = null;
        if (!opener || !opener.isConnected) {
            const fallback = document.getElementById(fallbackId);
            if (fallback) fallback.focus();
        }
    }

    // Back arrow, backdrop and Escape -- the wiring every card on top of the
    // page needs. onEscape gets first refusal so a card with something nested
    // (the emoji picker) can unwind that first (MOD5).
    _setupOverlayCard(modalId, backId, onClose, onEscape) {
        const modal = document.getElementById(modalId);
        if (!modal) return;
        const back = document.getElementById(backId);
        if (back) back.addEventListener('click', onClose);
        // Matched on the overlay itself, so a click inside the sheet cannot
        // close it while the admin is typing in a field.
        modal.addEventListener('click', (e) => {
            if (e.target === modal) onClose();
        });
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                // The card is a sibling, not a descendant, so this must not let
                // the press reach the profile card's own handler as well.
                e.stopPropagation();
                if (onEscape && onEscape()) return;
                onClose();
                return;
            }
            this._trapDialogFocus(e, modal);
        });
    }

    // ---- Account Information card ----
    // "View profile" swaps cards rather than stacking on one, exactly as Change
    // password already does: only one card is ever on screen. The profile card
    // closes, so the back arrow is the only way back and it reopens the profile
    // card.
    openAccountInfoCard() {
        const accountModal = document.getElementById('accountModal');
        if (accountModal && accountModal.style.display !== 'none') this._closeDialog(accountModal);

        // Re-rendering would silently throw away anything typed but not saved,
        // and the back arrow is now the main way out of this card. So a dirty
        // form is left exactly as the admin left it.
        if (this.profileDirty) {
            this._openDialog(document.getElementById('accountInfoModal'));
            return;
        }

        // Otherwise render from cache first: the server round trip must not gate
        // the card appearing, or a slow connection makes the click look dead
        // (OFF1/OFF4).
        this._renderProfileBody(this.getEffectiveProfile(AuthAPI.getCurrentUser() || {}));
        this._openDialog(document.getElementById('accountInfoModal'));

        // Then reconcile with the server.
        TicketAPI.getMyProfile().then((serverProfile) => {
            // getMyProfile resolves null on failure and has already logged it,
            // so the cached render stands and this is a no-op (OFF4).
            if (!serverProfile || this.profileDirty) return;
            this._renderProfileBody(this.getEffectiveProfile(serverProfile));
        });
    }

    // The back arrow, Escape and the backdrop all land here: back to the profile
    // card, focused on the row that opened this one (MOD5).
    closeAccountInfoCard() {
        this._closeDialog(document.getElementById('accountInfoModal'));
        this.openAccountDialog();
        const row = document.getElementById('acctViewProfile');
        if (row) row.focus();
    }

    setupAccountInfoCard() {
        this._setupOverlayCard('accountInfoModal', 'accountInfoBack',
            () => this.closeAccountInfoCard());
    }

    // ---- picture options card ----
    // Opened by an avatar: the profile card's hero, or the one in the Account
    // Information card. Same four controls the old popover carried, promoted to
    // a real overlay (MOD1/MOD6).
    openPictureDialog() {
        this._openStackedCard('pictureModal', '_pictureOpener');
    }

    closePictureDialog() {
        // The picker is nested, so it must not survive the card closing.
        if (this._profileEmojiPanel) {
            this._profileEmojiPanel.hidden = true;
            if (this._profileEmojiToggle) {
                this._profileEmojiToggle.setAttribute('aria-expanded', 'false');
            }
        }
        this._closeStackedCard('pictureModal', '_pictureOpener', 'accountHeroAvatarBtn');
    }

    setupPictureDialog() {
        this._setupOverlayCard('pictureModal', 'pictureModalBack',
            () => this.closePictureDialog(),
            // Escape unwinds the emoji picker before the card (MOD5).
            () => {
                if (!this._profileEmojiPanel || this._profileEmojiPanel.hidden) return false;
                this._profileEmojiPanel.hidden = true;
                if (this._profileEmojiToggle) {
                    this._profileEmojiToggle.setAttribute('aria-expanded', 'false');
                    this._profileEmojiToggle.focus();
                }
                return true;
            });
    }

    // The "Unsaved changes" dot. A plain indicator, deliberately not a live
    // region: adminProfileSaveMsg is the single announcement on save, and two
    // competing live regions would talk over each other.
    _setProfileUnsaved(dirty) {
        const el = document.getElementById('adminProfileUnsaved');
        if (el) el.classList.toggle('show', !!dirty);
        // Kept as real state, not just a class: the profile body uses it to
        // decide whether a late /users/me response may still write to the form.
        this.profileDirty = !!dirty;
    }

    // One renderer for every surface that shows the signed-in admin's avatar --
    // the profile card's hero, the Account Information card, and the sidebar
    // identity block -- so the precedence is identical everywhere and to the
    // Users table: photo, then emoji, then initials.
    _renderAdminAvatarPreview(src, emoji, initial) {
        ['adminProfileAvatarPreview', 'adminInfoAvatarVisual', 'sidebarAvatar']
            .forEach((id) => {
                const el = document.getElementById(id);
                if (el) this._fillAvatarDisc(el, src, emoji, initial);
            });
    }

    _fillAvatarDisc(el, src, emoji, initial) {
        const useEmoji = !src && emoji;
        el.classList.toggle('has-emoji', !!useEmoji);
        if (src) {
            const img = document.createElement('img');
            // The sidebar already styles any descendant img (.sidebar-avatar img),
            // so only the profile disc needs a class.
            if (el.id !== 'sidebarAvatar') img.className = 'user-avatar-img';
            img.src = src;
            img.alt = '';
            img.setAttribute('aria-hidden', 'true');
            // A dead URL must fall back to the monogram rather than leaving an
            // empty disc, which would read as "no avatar" instead of "broken".
            img.addEventListener('error', () => this._fillAvatarDisc(el, '', emoji, initial));
            el.textContent = '';
            el.appendChild(img);
        } else if (useEmoji) {
            const span = document.createElement('span');
            // .user-avatar-emoji is the only class that carries an emoji size
            // here: the card sets it to 58px in .avatar-btn and 13px in
            // .mini-avatar. A second class name would need its own rule in
            // every one of the eleven theme blocks to mean anything.
            span.className = 'user-avatar-emoji';
            span.setAttribute('aria-hidden', 'true');
            span.textContent = emoji;
            el.textContent = '';
            el.appendChild(span);
        } else if (el.classList.contains('visual') || el.classList.contains('mini-avatar')) {
            // The reference wraps initials in a span so it can size them
            // independently of the host. Only the new card wraps; the sidebar
            // and the profile card's own hero keep their bare text node.
            const span = document.createElement('span');
            span.className = 'initials-txt';
            span.setAttribute('aria-hidden', 'true');
            span.textContent = initial;
            el.textContent = '';
            el.appendChild(span);
        } else {
            el.textContent = initial;
        }
    }

    // The remove/clear controls only make sense for whichever kind of avatar is
    // actually set, so each is shown in response to the server state.
    _syncAdminAvatarButtons(photo, emoji) {
        const removeBtn = document.getElementById('adminRemoveAvatarBtn');
        if (removeBtn) removeBtn.classList.toggle('is-hidden', !photo);
        const clearEmojiBtn = document.getElementById('adminProfileEmojiClearBtn');
        if (clearEmojiBtn) clearEmojiBtn.classList.toggle('is-hidden', !emoji);
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

        // Emoji avatar, mirroring the technician dialog so both behave
        // identically. Rendered once: the list is static, and rebuilding it on
        // every open would drop keyboard focus back to the top of the dialog.
        const emojiPanel = document.getElementById('adminProfileEmojiPanel');
        const emojiToggle = document.getElementById('adminProfileEmojiBtn');
        // The picture dialog's Escape ladder needs to reach the picker.
        this._profileEmojiPanel = emojiPanel;
        this._profileEmojiToggle = emojiToggle;

        // The picker lives inside the picture dialog, so it is a plain inline
        // block there -- no anchoring, no outside-click dismissal (MOD2/MOD3).
        emojiToggle.addEventListener('click', () => {
            const opening = emojiPanel.hidden;
            emojiPanel.hidden = !opening;
            emojiToggle.setAttribute('aria-expanded', String(opening));
        });
        if (window.EmojiPicker) {
            window.EmojiPicker.render(
                document.getElementById('adminProfileEmojiChoices'),
                (emoji) => this.setAdminAvatarEmoji(emoji));
        } else {
            // The picker is local markup, so this only happens if the script
            // failed to load. Hide the button rather than offer a dead control.
            emojiToggle.classList.add('is-hidden');
        }
        document.getElementById('adminProfileEmojiClearBtn')
            .addEventListener('click', () => this.clearAdminAvatarEmoji());
        // The dialog's own Escape ladder and focus trap live in
        // setupAccountDialog, because the profile view is now inside that
        // dialog: two keydown handlers on one element would double-fire.

        // The design's setDirty() on every field in a row. Readonly rows
        // (username, role) are skipped explicitly: they can never emit input
        // or change, so this matches the reference without a stray dirty dot.
        const rowFields = document.querySelectorAll('#accountInfoModal .frow input, #accountInfoModal .frow select');
        Array.prototype.forEach.call(rowFields, (field) => {
            if (field.readOnly || field.disabled) return;
            field.addEventListener('input', () => this._setProfileUnsaved(true));
            field.addEventListener('change', () => this._setProfileUnsaved(true));
        });
        // The design's syncIdentity(): the two fields the identity column
        // mirrors update it live.
        ['adminProfileDisplayName', 'adminProfileUsername'].forEach((id) => {
            const field = document.getElementById(id);
            if (field) field.addEventListener('input', () => this._syncProfileIdentity());
        });
    }

    async handleAdminAvatarFile(file) {
        if (!file) return;
        if (!/^image\//.test(file.type)) {
            this.showToast('Please choose an image file.', true);
            return;
        }
        const me = AuthAPI.getCurrentUser() || {};
        if (me.id == null) {
            this.showToast('Could not identify your account.', true);
            return;
        }
        try {
            const updated = await uploadAvatar(me.id, file);
            // A server-side photo supersedes any legacy local copy, so drop it
            // rather than letting the two disagree on the next load.
            this.saveLocalProfile({ avatar: '' });
            this._syncSelfUser(updated);
            this.refreshAdminAvatarUI();
            this.renderIdentity();
            this.showToast('Profile photo updated.');
        } catch (err) {
            this.showToast(err.message || 'Could not upload the photo.', true);
        }
    }

    refreshAdminAvatarUI() {
        const eff = this.getEffectiveProfile();
        const user = AuthAPI.getCurrentUser() || {};
        const name = eff.displayName || user.username || 'Admin';
        const initial = name.charAt(0).toUpperCase();
        this._renderAdminAvatarPreview(eff.avatar, eff.avatarEmoji, initial);
        this._syncAdminAvatarButtons(eff.avatar, eff.avatarEmoji);
        // The rail previews track the same source, so an upload, emoji pick or
        // removal is reflected on all three chips without reopening the dialog.
        this._renderAdminPreview(eff, initial);
    }

    async removeAdminAvatar() {
        const me = AuthAPI.getCurrentUser() || {};
        if (me.id == null) {
            this.showToast('Could not identify your account.', true);
            return;
        }
        try {
            const updated = await deleteAvatar(me.id);
            this._syncSelfUser(updated);
            this.refreshAdminAvatarUI();
            this.renderIdentity();
            this.showToast('Profile photo removed.');
        } catch (err) {
            this.showToast(err.message || 'Could not remove the photo.', true);
        }
    }

    async setAdminAvatarEmoji(emoji) {
        const me = AuthAPI.getCurrentUser() || {};
        if (me.id == null) {
            this.showToast('Could not identify your account.', true);
            return;
        }
        try {
            const updated = await setAvatarEmoji(me.id, emoji);
            this._syncSelfUser(updated);
            this.refreshAdminAvatarUI();
            this.renderIdentity();
            this.showToast('Emoji avatar set.');
        } catch (err) {
            this.showToast(err.message || 'Could not set the emoji.', true);
        }
    }

    async clearAdminAvatarEmoji() {
        const me = AuthAPI.getCurrentUser() || {};
        if (me.id == null) return;
        try {
            const updated = await clearAvatarEmoji(me.id);
            this._syncSelfUser(updated);
            this.refreshAdminAvatarUI();
            this.renderIdentity();
            this.showToast('Emoji cleared.');
        } catch (err) {
            this.showToast(err.message || 'Could not clear the emoji.', true);
        }
    }

    saveAdminProfile() {
        this.saveLocalProfile({
            displayName: document.getElementById('adminProfileDisplayName').value.trim(),
            phone: document.getElementById('adminProfilePhone').value.trim(),
            department: document.getElementById('adminProfileDepartment').value,
            email: document.getElementById('adminProfileEmail').value.trim()
        });
        this.renderIdentity();
        // Everything typed is now persisted, so the dirty dot has nothing left
        // to point at. The saved names in the rail are refreshed with it.
        this._setProfileUnsaved(false);
        this._syncProfileIdentity();
        const msg = document.getElementById('adminProfileSaveMsg');
        if (msg) {
            msg.classList.add('is-visible');
            setTimeout(() => { msg.classList.remove('is-visible'); }, 2500);
        }
        // The design's save-btn.saved state: the button itself confirms for a
        // moment. The live region above stays because a button changing its own
        // label is not reliably announced.
        const saveBtn = document.getElementById('adminSaveProfileBtn');
        if (saveBtn) {
            saveBtn.classList.add('saved');
            saveBtn.textContent = 'Saved';
            setTimeout(() => {
                saveBtn.classList.remove('saved');
                saveBtn.textContent = 'Save Changes';
            }, 1800);
        }
    }

    // ============ Change password modal ============
    // Same technique as View profile: the profile card closes and this card
    // takes its place, so only one card is ever on screen and the back arrow is
    // the only way back.
    openChangePasswordModal() {
        const modal = document.getElementById('changePasswordModal');
        if (!modal) return;
        const accountModal = document.getElementById('accountModal');
        if (accountModal && accountModal.style.display !== 'none') this._closeDialog(accountModal);
        document.getElementById('changePasswordForm').reset();
        // The first control is the back arrow, which is navigation. Land on the
        // current password field instead, so a keyboard user can start typing.
        this._openDialog(modal, document.getElementById('adminCurrentPassword'));
    }

    // Back arrow, close control, Escape and the backdrop all land here: back to
    // the profile card, focused on the row that opened this one (MOD5).
    closeChangePasswordModal() {
        this._closeDialog(document.getElementById('changePasswordModal'));
        this.openAccountDialog();
        const row = document.getElementById('acctChangePassword');
        if (row) row.focus();
    }

    setupChangePasswordModal() {
        document.getElementById('changePasswordForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleChangePassword();
        });
        this._setupOverlayCard('changePasswordModal', 'changePasswordBack',
            () => this.closeChangePasswordModal());

        // The close control sits in the card's top-right corner, so this card has
        // two exits; both go back to the profile card rather than dropping the
        // admin on an empty page.
        const closeBtn = document.getElementById('closeChangePasswordModal');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeChangePasswordModal());
            closeBtn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.closeChangePasswordModal();
                }
            });
        }
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
            document.getElementById('changePasswordForm').reset();
            // Same exit as backing out, so a successful change lands the admin
            // back on the profile card instead of an empty page.
            this.closeChangePasswordModal();
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
            this.applyDashboardCategoryVisibility();
        } catch (error) {
            console.error('Error loading dashboard:', error);
            this.applyDashboardCategoryVisibility();
        }
        this.renderWorkloadWidget();
    }

    // Stat cards on the dashboard whose notification category is disabled
    // (e.g. SLA cards when 'sla_breaches' is off) are hidden — same policy as
    // the bell state tabs. Never leaves a hole: unhidden again on re-enable.
    applyDashboardCategoryVisibility() {
        if (typeof window.NotificationPrefs === 'undefined') return;
        Object.keys(DASHBOARD_CATEGORY_CARDS).forEach(cid => {
            const hidden = !window.NotificationPrefs.isCategoryEnabled(cid);
            DASHBOARD_CATEGORY_CARDS[cid].forEach(selector => {
                document.querySelectorAll(selector).forEach(card => {
                    if (hidden) {
                        card.style.display = 'none';
                    } else {
                        card.style.display = '';
                    }
                });
            });
        });
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
                <td data-label="Select"><label class="ticket-check-wrap"><input type="checkbox" class="ticket-select-checkbox" data-id="${ticket.id}" ${this.selectedTicketIds.has(ticket.id) ? 'checked' : ''}></label></td>
                <td data-label="Ticket #"><strong>${ticket.ticket_number}</strong></td>
                <td data-label="Title">${this._esc(ticket.title)}</td>
                <td data-label="Category">${this._esc(this.capitalize(ticket.category))}</td>
                <td data-label="Priority"><span class="priority-badge ${ticket.priority}">${this.capitalize(ticket.priority)}</span></td>
                <td data-label="Status"><span class="status-badge ${ticket.status}">${this.capitalize(ticket.status.replace('_', ' '))}</span></td>
                <td data-label="SLA">${this.slaBadge(ticket)}</td>
                <td data-label="Assigned To">${this.assigneeCell(ticket.assigned_to)}</td>
                <td data-label="Created">${new Date(ticket.created_at).toLocaleDateString()}</td>
                <td data-label="Actions">
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

            ${ticket.priority_explanation && ticket.priority_source ? `<div class="priority-cause" style="margin-bottom:20px;">
                <strong>Priority reason (${this.capitalize(ticket.priority_source.replace('_', ' '))}):</strong>
                <p style="margin:4px 0 0;color:var(--text-muted);">${this._esc(ticket.priority_explanation)}</p>
            </div>` : ''}

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

    // Replace one user in the cached list from a server response, so changing
    // one field (a photo) does not require refetching every user.
    mergeUser(user) {
        if (!user || user.id == null) return;
        const i = this.users.findIndex(u => u.id === user.id);
        if (i === -1) this.users.push(user);
        else this.users[i] = user;
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

    // Avatar for a user row in the Users table. Same precedence as the ticket
    // table and the profile card: photo, then chosen emoji, then the username
    // monogram. Decorative, because the username sits beside it as real text.
    userCellAvatar(user) {
        const name = String(user.username || '?');
        const initial = this._esc(name.charAt(0).toUpperCase() || '?');
        const photo = avatarUrl(user);
        if (photo) {
            return '<span class="user-avatar" aria-hidden="true">'
                 + `<img class="user-avatar-img" src="${this._esc(photo)}" alt="" `
                 + `data-initial="${initial}">`
                 + '</span>';
        }
        if (user.avatar_emoji) {
            return '<span class="user-avatar has-emoji" aria-hidden="true">'
                 + `<span class="user-avatar-emoji">${this._esc(user.avatar_emoji)}</span>`
                 + '</span>';
        }
        return `<span class="user-avatar" aria-hidden="true">${initial}</span>`;
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
            <tr${user.is_active === false ? ' class="is-inactive"' : ''}>
                <td>
                    <div class="user-cell">
                        ${this.userCellAvatar(user)}
                        <strong>${this._esc(user.username)}</strong>
                    </div>
                </td>
                <td>${this._esc(user.email)}</td>
                <td><span class="role-badge ${this._roleBadgeClass(user.role)}">${this.capitalize(user.role || 'staff')}</span></td>
                <td>${user.department ? this._esc(user.department) : 'N/A'}</td>
                <td>${user.is_active === false ? '<span class="status-badge inactive">Inactive</span>' : '<span class="status-badge open">Active</span>'}</td>
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

    // Refresh the open technician card in place, without reopening it. The
    // card now shows derived state (status dot, counts, row label) that a
    // table re-render alone will not update, so a mutation has to push the
    // new values into the dialog the admin is still looking at.
    refreshOpenUserDetail(id) {
        const modal = document.getElementById('userDetailModal');
        if (!modal || modal.style.display === 'none') return;
        if (this.activeDetailUserId !== id) return;
        const user = this.users.find(u => u.id === id);
        if (user) this.openUserDetail(user.id);
    }

    async deleteUser(id) {
        if (!confirm('Deactivate this user? They will no longer be able to log in, but their ticket history is preserved.')) return;

        try {
            await TicketAPI.deleteUser(id);
            this.showToast('User deactivated successfully!');
            await this.loadUsers();
            this.renderUsers();
            this.refreshOpenUserDetail(id);
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
            this.refreshOpenUserDetail(id);
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
        const detailAvatar = document.getElementById('userDetailAvatar');
        const detailPhoto = avatarUrl(user);
        const detailEmoji = detailPhoto ? '' : (user.avatar_emoji || '');
        detailAvatar.textContent = detailPhoto || detailEmoji ? '' : initial;
        detailAvatar.classList.toggle('has-emoji', !detailPhoto && !!detailEmoji);
        if (detailEmoji) {
            // Validated server-side as emoji-only, and escaped again here.
            const face = document.createElement('span');
            face.className = 'user-avatar-emoji';
            face.setAttribute('aria-hidden', 'true');
            face.textContent = detailEmoji;
            detailAvatar.appendChild(face);
        }
        if (detailPhoto) {
            const img = document.createElement('img');
            img.className = 'user-avatar-img';
            img.alt = '';
            img.src = detailPhoto;
            // Same degradation as the table disc: fall back to the emoji if
            // there is one, otherwise the monogram.
            img.addEventListener('error', () => {
                img.remove();
                if (detailEmoji) {
                    detailAvatar.classList.add('has-emoji');
                    const face = document.createElement('span');
                    face.className = 'user-avatar-emoji';
                    face.setAttribute('aria-hidden', 'true');
                    face.textContent = detailEmoji;
                    detailAvatar.appendChild(face);
                } else {
                    detailAvatar.textContent = initial;
                }
            });
            detailAvatar.appendChild(img);
        }
        document.getElementById('userDetailName').textContent = `@${user.username}`;
        document.getElementById('userDetailRole').textContent = this.capitalize(user.role || 'staff');
        document.getElementById('userDetailRole').className = `role-badge ${this._roleBadgeClass(user.role)}`;
        document.getElementById('userDetailEmail').textContent = user.email || 'N/A';
        document.getElementById('userDetailDepartment').textContent = user.department || 'N/A';
        document.getElementById('userDetailPhone').textContent = user.phone || 'Not linked';

        const active = user.is_active !== false;
        document.getElementById('userDetailStatus').innerHTML = active
            ? '<span class="status-badge open">Active</span>'
            : '<span class="status-badge inactive">Inactive</span>';
        // The dot is a glanceable duplicate of the status row, so it is
        // aria-hidden rather than announced twice.
        document.getElementById('userDetailStatusDot').classList.toggle('is-off', !active);

        document.getElementById('userDetail2fa').textContent = user.totp_enabled ? 'Enabled' : 'Not enabled';

        const lockedUntil = user.locked_until;
        document.getElementById('userDetailLock').textContent = lockedUntil
            ? `Locked until ${new Date(lockedUntil).toLocaleString()}`
            : 'Not locked';

        // Counts come from the already-loaded ticket set, so they are exact
        // rather than sampled. Admins load every ticket, so nothing is missing.
        const assigned = this.assignedTicketsFor(user.username);
        const resolved = assigned.filter(t => t.status === 'resolved').length;
        document.getElementById('userDetailStatTotal').textContent = assigned.length;
        document.getElementById('userDetailStatResolved').textContent = resolved;
        document.getElementById('userDetailStatActive').textContent = assigned.length - resolved;

        // These are now card rows rather than buttons, so the class list is left
        // alone: overwriting it here would strip the row styling. Only the
        // label and the danger emphasis change.
        const toggleBtn = document.getElementById('userDetailToggleActiveBtn');
        document.getElementById('userDetailToggleActiveLabel').textContent =
            active ? 'Deactivate technician' : 'Reactivate technician';
        toggleBtn.classList.toggle('is-danger', active);
        toggleBtn.setAttribute('aria-label',
            active ? `Deactivate ${user.username}` : `Reactivate ${user.username}`);

        // Only offer "Remove photo" when there is one to remove, and "Use
        // initials" only when an emoji is actually set. The emoji panel starts
        // closed for each technician so it never shows the previous user's
        // state.
        document.getElementById('userDetailAvatarRemoveBtn').style.display =
            user.avatar_url ? 'inline-block' : 'none';
        document.getElementById('userDetailEmojiClearBtn').style.display =
            user.avatar_emoji ? 'inline-block' : 'none';
        const emojiPanel = document.getElementById('userDetailEmojiPanel');
        const emojiToggle = document.getElementById('userDetailEmojiBtn');
        if (emojiPanel) {
            emojiPanel.hidden = true;
            emojiToggle.setAttribute('aria-expanded', 'false');
        }

        this.renderUserDetailTickets(user);
        this._openDialog(document.getElementById('userDetailModal'));
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

    // ============ Settings: Notification Categories ============
    // Admin-only manager over the live category registry (custom-trigger
    // subsystem). Soft deletes only; cid is immutable server-side.
    async loadNotificationCategories() {
        const container = document.getElementById('notificationCategoryList');
        if (!container) return;
        container.innerHTML = '<p style="color:#999;">Loading...</p>';

        const cats = await TicketAPI.getNotificationCategories();
        this.renderNotificationCategoryList(cats);
        await this.populateBroadcastCategories(cats);
    }

    notificationCategoryIcon(cid, meta) {
        if (meta && meta.icon) return meta.icon;
        return 'bell';
    }

    renderNotificationCategoryList(cats) {
        const container = document.getElementById('notificationCategoryList');
        if (!container) return;

        if (!cats || cats.length === 0) {
            container.innerHTML = '<p style="color:#999;">No notification categories yet.</p>';
            return;
        }

        container.innerHTML = cats.map(c => `
            <div class="nc-row${c.active ? '' : ' is-inactive'}" data-cid="${this._esc(c.cid)}">
                <span class="nc-icon" aria-hidden="true">${Icons.render(this.notificationCategoryIcon(c.cid, c))}</span>
                <div class="nc-info">
                    <strong>${this._esc(c.label)}${c.built_in ? ' <em class="nc-builtin">built-in</em>' : ''}</strong>
                    <p>${this._esc(c.description || '')}</p>
                </div>
                <span class="nc-badge nc-role">${this._esc(c.role)}</span>
                <span class="nc-badge ${c.active ? 'nc-active' : 'nc-off'}">${c.active ? 'active' : 'off'}</span>
                <button class="btn-sm btn-danger" aria-label="Deactivate ${this._esc(c.cid)}" onclick="app.deactivateNotificationCategory('${this._esc(c.cid)}')">
                    ${Icons.render('ban')}
                </button>
            </div>
        `).join('');
    }

    async handleAddNotificationCategory() {
        const input = document.getElementById('newNotificationCategoryName');
        const label = input.value.trim();
        if (!label) return;

        try {
            await TicketAPI.createNotificationCategory({ label });
            this.showToast('Notification category added.');
            input.value = '';
            await this.loadNotificationCategories();
            if (typeof window.NotificationPrefs !== 'undefined') {
                try { await window.NotificationPrefs.load(); } catch (e) { /* label fallback only */ }
            }
        } catch (error) {
            this.showToast(error.message || 'Failed to add notification category.', true);
        }
    }

    async deactivateNotificationCategory(cid) {
        if (!confirm('Deactivate this notification category? Its bell tab disappears and it stops receiving sends. Existing notifications are kept.')) return;
        try {
            await TicketAPI.deactivateNotificationCategory(cid);
            this.showToast('Notification category deactivated.');
            await this.loadNotificationCategories();
            if (typeof window.NotificationPrefs !== 'undefined') {
                try { await window.NotificationPrefs.load(); } catch (e) { /* label fallback only */ }
            }
        } catch (error) {
            this.showToast(error.message || 'Failed to deactivate notification category.', true);
        }
    }

    // Populates the broadcast "category" select with categories that can
    // actually receive a manual send: custom/broadcast categories plus the
    // built-in announcements row.
    async populateBroadcastCategories(cats) {
        const sel = document.getElementById('broadcastCategory');
        if (!sel) return;
        const options = ['<option value="">Default (Announcements)</option>'];
        (cats || []).forEach(c => {
            const sendable = c.active && (!c.built_in || c.cid === 'announcements');
            if (sendable) {
                options.push(`<option value="${this._esc(c.cid)}">${this._esc(c.label)}</option>`);
            }
        });
        sel.innerHTML = options.join('');
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
        await this.loadNotificationCategories();
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
                : rules.map((rule, idx) => this.renderPriorityRuleCard(rule, idx, rules.length)).join('')}

            <div style="border-top:1px solid var(--surface-muted, #e0e0e0);margin-top:16px;padding-top:16px;">
                <strong style="display:block;margin-bottom:8px;">Test a ticket against these rules</strong>
                <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;">
                    <div class="form-group" style="flex:1 1 200px;min-width:0;">
                        <label for="previewTitle">Title</label>
                        <input type="text" id="previewTitle" placeholder="e.g. Office computer won't boot">
                    </div>
                    <div class="form-group" style="flex:1 1 240px;min-width:0;">
                        <label for="previewDesc">Description</label>
                        <input type="text" id="previewDesc" placeholder="e.g. blue screen on login">
                    </div>
                    <div class="form-group" style="flex:1 1 140px;min-width:0;">
                        <label for="previewCategory">Category</label>
                        <select id="previewCategory">
                            <option value="">Any</option>
                            <option>Network</option>
                            <option>Hardware</option>
                            <option>Software</option>
                            <option>Security</option>
                            <option>General</option>
                            <option>Other</option>
                        </select>
                    </div>
                    <button type="button" class="btn-primary btn-sm" onclick="app.previewPriorityTest()">${Icons.render('exclamation-triangle')} Preview</button>
                </div>
                <div id="priorityPreviewResult" aria-live="polite" style="margin-top:10px;"></div>
            </div>`;
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

    async previewPriorityTest() {
        const resultEl = document.getElementById('priorityPreviewResult');
        if (!resultEl) return;
        const title = document.getElementById('previewTitle').value;
        const desc = document.getElementById('previewDesc').value;
        const category = document.getElementById('previewCategory').value || '';

        // Tests against the live/staged config (what a new ticket would see).
        // What-if preview of unsaved edits in the panel is out of scope.
        resultEl.innerHTML = '<span style="display:inline-flex;gap:8px;align-items:center;">' + Icons.render('spinner') + ' Evaluating…</span>';
        try {
            const res = await TicketAPI.previewPriorityRules(
                { title, description: desc, category, department: null, role: 'staff', created_at: new Date().toISOString() },
                null
            );
            const priority = res.priority || 'medium';
            const source = res.fallback ? 'fallback' : (res.priority_source || 'rule_engine');
            resultEl.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                    <span class="priority-badge ${priority}">${this.capitalize(priority)}</span>
                    <span style="font-size:0.8rem;color:var(--text-muted, #8191a1);">via ${this._esc(source.replace('_', ' '))}</span>
                </div>
                <p style="margin:0;color:var(--text, inherit);font-size:0.88rem;line-height:1.5;">${this._esc(res.explanation || '')}</p>
                ${res.rules_version ? `<p style="margin:6px 0 0;font-size:0.75rem;color:var(--text-muted, #8191a1);">Rules version: ${this._esc(res.rules_version)}</p>` : ''}`;
        } catch (error) {
            resultEl.innerHTML = `<p style="margin:0;color:var(--danger-dark, #b91c1c);font-size:0.88rem;">${this._esc(error.message || 'Preview failed.')}</p>`;
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
        const catSel = document.getElementById('broadcastCategory');
        const category = catSel ? catSel.value : '';
        if (category) payload.category = category;
        if (!payload.message) return;
        try {
            const result = await TicketAPI.broadcastNotification(payload);
            this.showToast(`Broadcast sent to ${result.count} user(s).`);
            document.getElementById('broadcastForm').reset();
            await this.loadNotificationCategories();
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

// SidebarManager is loaded from shared/js/sidebar.js

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
/* Profile settings dialog shared by the staff and admin portals. */
class ProfileDialog {
    constructor() {
        this.trigger = document.getElementById('identityLauncher');
        if (!this.trigger) return;
        this.themeKey = document.body.dataset.portal === 'admin' ? 'admin_theme' : 'user_theme';
        this.panels = ['Profile', 'Appearance', 'Notifications', 'Account'];
        this.index = 0;
        this.opened = false;
        this.notificationsLoaded = false;
        this.motion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.build();
    }

    build() {
        this.portal = document.createElement('div');
        this.portal.className = 'profile-dialog-portal';
        this.portal.hidden = true;
        this.dialog = document.createElement('section');
        this.dialog.className = 'profile-dialog';
        this.dialog.setAttribute('role', 'dialog');
        this.dialog.setAttribute('aria-modal', 'true');
        this.dialog.setAttribute('aria-labelledby', 'profileDialogTitle');
        this.dialog.tabIndex = -1;
        this.portal.appendChild(this.dialog);
        document.body.appendChild(this.portal);

        this.dialog.innerHTML = `
            <header class="profile-dialog-header">
                <button type="button" class="profile-nav profile-nav-prev" aria-label="Previous panel">${Icons.render('chevron-left')}</button>
                <div class="profile-panel-position" aria-live="polite" aria-atomic="true"><span id="profilePanelName"></span><span id="profilePanelCount"></span></div>
                <button type="button" class="profile-nav profile-nav-next" aria-label="Next panel">${Icons.render('chevron-right')}</button>
                <button type="button" class="profile-dialog-close" aria-label="Close profile settings">${Icons.render('x')}</button>
            </header>
            <div class="profile-dialog-body" id="profileDialogPanels" aria-live="polite"></div>
            <span class="visually-hidden" id="profileDialogTitle">Profile settings</span>`;
        this.body = this.dialog.querySelector('.profile-dialog-body');
        this.prev = this.dialog.querySelector('.profile-nav-prev');
        this.next = this.dialog.querySelector('.profile-nav-next');
        this.closeBtn = this.dialog.querySelector('.profile-dialog-close');
        this.nameLabel = this.dialog.querySelector('#profilePanelName');
        this.countLabel = this.dialog.querySelector('#profilePanelCount');
        this.renderPanels();
        this.prev.addEventListener('click', () => this.navigate(-1));
        this.next.addEventListener('click', () => this.navigate(1));
        this.closeBtn.addEventListener('click', () => this.close());
        this.trigger.addEventListener('click', () => this.opened ? this.close() : this.open());
        this.portal.addEventListener('pointerdown', e => { if (e.target === this.portal) this.close(); });
        document.addEventListener('keydown', e => this.onKeydown(e));
        window.addEventListener('resize', () => { if (this.opened) this.position(); });
    }

    user() { return (window.AuthAPI && AuthAPI.getCurrentUser()) || {}; }

    renderPanels() {
        const user = this.user();
        const username = user.username || 'User';
        const displayName = user.name || username;
        const themes = [
            ['daylight', 'Daylight'], ['quiet-light', 'Quiet Light'], ['solarized-light', 'Solarized Light'],
            ['abyss', 'Abyss'], ['night-owl', 'Night Owl'], ['high-contrast', 'High Contrast'],
            ['flexoki-light', 'Flexoki Light'], ['catppuccin-latte', 'Catppuccin Latte'],
            ['catppuccin-mocha', 'Catppuccin Mocha'], ['nord', 'Nord'], ['gruvbox', 'Gruvbox']
        ];
        const themeOptions = themes.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
        const safeName = this.escape(displayName);
        const safeUser = this.escape(username);
        const safeEmail = this.escape(user.email || 'No email on file');
        const storedTheme = localStorage.getItem(this.themeKey) || document.documentElement.dataset.theme || 'daylight';
        const notify = typeof NotificationPrefs !== 'undefined';
        this.body.innerHTML = `
            <section class="profile-panel is-current" data-panel="0" aria-labelledby="profileName">
                <div class="profile-avatar-wrap" aria-hidden="true">${Icons.render('user')}</div>
                <h2 class="profile-name" id="profileName">${safeName}</h2>
                <p class="profile-handle">@${safeUser}</p>
                <p class="profile-detail">${safeEmail}</p>
                <label class="profile-field">Availability
                    <select data-profile-status aria-label="Availability status">
                        <option>Available</option><option>Away</option><option>Busy</option>
                    </select>
                </label>
                <p class="profile-feedback" aria-live="polite">Availability is shown for this session.</p>
            </section>
            <section class="profile-panel" data-panel="1" aria-label="Appearance" aria-hidden="true" inert>
                <h2>Appearance</h2><p class="profile-panel-intro">Choose how this portal looks on this device.</p>
                <label class="profile-field">Color theme<select data-profile-theme aria-label="Color theme">${themeOptions}</select></label>
                <label class="profile-setting-row"><span><strong>Compact density</strong><small>Fit more information on screen</small></span><input type="checkbox" role="switch" data-profile-density aria-label="Compact density"></label>
                <p class="profile-feedback" data-appearance-feedback aria-live="polite">Changes apply immediately and are saved on this device.</p>
            </section>
            <section class="profile-panel" data-panel="2" aria-label="Notifications" aria-hidden="true" inert>
                <h2>Notifications</h2><p class="profile-panel-intro">Manage the ticket updates you receive.</p>
                <div class="profile-notification-content">${notify ? '<p>Loading notification preferences…</p>' : '<p>Notification settings are unavailable right now.</p>'}</div>
            </section>
            <section class="profile-panel" data-panel="3" aria-label="Account" aria-hidden="true" inert>
                <h2>Account</h2><p class="profile-panel-intro">Signed in as <strong>${safeUser}</strong></p>
                <p class="profile-detail">${safeEmail}</p>
                <button type="button" class="profile-signout">${Icons.render('sign-out-alt')}<span>Sign out</span></button>
            </section>`;
        this.panelsEls = Array.from(this.body.querySelectorAll('[data-panel]'));
        this.body.querySelector('[data-profile-theme]').value = themes.some(t => t[0] === storedTheme) ? storedTheme : 'daylight';
        const savedDensity = localStorage.getItem('profile_density');
        this.body.querySelector('[data-profile-density]').checked = savedDensity
            ? savedDensity === 'compact'
            : document.documentElement.classList.contains('density-compact');
        if (savedDensity) document.documentElement.classList.toggle('density-compact', savedDensity === 'compact');
        this.body.querySelector('[data-profile-status]').value = sessionStorage.getItem('profile_status') || 'Available';
        this.body.querySelector('[data-profile-status]').addEventListener('change', e => {
            sessionStorage.setItem('profile_status', e.target.value);
            e.target.closest('.profile-panel').querySelector('.profile-feedback').textContent = `Availability set to ${e.target.value}.`;
        });
        this.body.querySelector('[data-profile-theme]').addEventListener('change', e => this.applyTheme(e.target.value));
        this.body.querySelector('[data-profile-density]').addEventListener('change', e => {
            document.documentElement.classList.toggle('density-compact', e.target.checked);
            localStorage.setItem('profile_density', e.target.checked ? 'compact' : 'comfortable');
            this.body.querySelector('[data-appearance-feedback]').textContent = e.target.checked ? 'Compact density is on.' : 'Comfortable density is on.';
        });
        this.body.querySelector('.profile-signout').addEventListener('click', () => AuthAPI.logout());
        this.showPanel(0, false);
    }

    escape(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

    applyTheme(theme) {
        const dark = ['abyss', 'night-owl', 'high-contrast', 'catppuccin-mocha', 'nord', 'gruvbox'].includes(theme);
        document.documentElement.dataset.theme = theme;
        document.documentElement.classList.toggle('dark-theme', dark);
        localStorage.setItem(this.themeKey, theme);
        this.body.querySelector('[data-appearance-feedback]').textContent = `${theme.replace(/-/g, ' ')} theme applied.`;
    }

    showPanel(index, animate = true, direction = 1) {
        this.index = index;
        this.panelsEls.forEach((panel, i) => {
            const active = i === index;
            panel.classList.toggle('is-current', active);
            panel.classList.remove('slide-from-left', 'slide-from-right');
            if (active && animate && !this.motion) panel.classList.add(direction > 0 ? 'slide-from-right' : 'slide-from-left');
            panel.toggleAttribute('inert', !active);
            panel.setAttribute('aria-hidden', active ? 'false' : 'true');
        });
        this.nameLabel.textContent = this.panels[index];
        this.countLabel.textContent = `${index + 1} of ${this.panels.length}`;
        this.prev.disabled = index === 0;
        this.next.disabled = index === this.panels.length - 1;
        if (index === 2 && !this.notificationsLoaded && typeof NotificationPrefs !== 'undefined') {
            this.notificationsLoaded = true;
            NotificationPrefs.render(this.body.querySelector('.profile-notification-content'));
        }
    }

    navigate(delta) {
        const target = Math.max(0, Math.min(this.panels.length - 1, this.index + delta));
        if (target !== this.index) this.showPanel(target, true, delta);
    }

    open() {
        if (this.opened) return;
        this.opened = true;
        this.portal.hidden = false;
        this.portal.classList.add('profile-dialog-portal--active');
        this.trigger.setAttribute('aria-expanded', 'true');
        this.trigger.classList.add('is-profile-active');
        this.position();
        requestAnimationFrame(() => this.dialog.classList.add('is-open'));
        this.closeBtn.focus();
    }

    close() {
        if (!this.opened) return;
        this.opened = false;
        this.trigger.setAttribute('aria-expanded', 'false');
        this.trigger.classList.remove('is-profile-active');
        this.dialog.classList.remove('is-open');
        this.portal.hidden = true;
        this.portal.classList.remove('profile-dialog-portal--active');
        this.trigger.focus();
    }

    position() {
        const rect = this.trigger.getBoundingClientRect();
        const width = Math.min(440, window.innerWidth - 32);
        this.dialog.style.width = `${width}px`;
        const maxRight = Math.max(16, window.innerWidth - width - 16);
        const right = Math.min(maxRight, Math.max(16, window.innerWidth - rect.right));
        this.dialog.style.right = `${right}px`;
        this.dialog.style.top = `${Math.max(16, Math.min(rect.bottom + 12, window.innerHeight - Math.min(620, window.innerHeight - 32) - 16))}px`;
    }

    onKeydown(e) {
        if (!this.opened) return;
        if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
        if (e.key === 'Tab') {
            const items = Array.from(this.dialog.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])')).filter(el => !el.closest('[inert]'));
            if (!items.length) { e.preventDefault(); this.dialog.focus(); return; }
            const first = items[0], last = items[items.length - 1];
            if (e.shiftKey && (document.activeElement === first || !this.dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && (document.activeElement === last || !this.dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    queueMicrotask(() => { window.profileDialog = new ProfileDialog(); });
});

/* Profile settings dialog shared by the staff and admin portals. */
class ProfileDialog {
    constructor() {
        this.trigger = document.getElementById('identityLauncher');
        if (!this.trigger) return;
        this.themeKey = document.body.dataset.portal === 'admin' ? 'admin_theme' : 'user_theme';
        this.panels = ['Profile', 'Appearance', 'Notifications', 'Account', 'Security'];
        this.index = 0;
        this.opened = false;
        this.notificationsLoaded = false;
        this.motion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.security2faEnabled = false;
        this.security2faSetup = null;
        this.securityBusy = false;
        this.securityFeedback = null;
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
                <button type="button" class="profile-back" data-profile-back aria-label="Back to previous section" hidden>${Icons.render('chevron-left')}</button>
                <div class="profile-panel-position" aria-live="polite" aria-atomic="true"><span id="profilePanelName"></span><span id="profilePanelCount"></span></div>
                <button type="button" class="profile-dialog-close" aria-label="Close profile settings">${Icons.render('x')}</button>
            </header>
            <div class="profile-dialog-body" id="profileDialogPanels" aria-live="polite"></div>
            <span class="visually-hidden" id="profileDialogTitle">Profile settings</span>`;
        this.body = this.dialog.querySelector('.profile-dialog-body');
        this.closeBtn = this.dialog.querySelector('.profile-dialog-close');
        this.backBtn = this.dialog.querySelector('[data-profile-back]');
        this.nameLabel = this.dialog.querySelector('#profilePanelName');
        this.countLabel = this.dialog.querySelector('#profilePanelCount');
        this.renderPanels();
        this.closeBtn.addEventListener('click', () => this.close());
        this.backBtn.addEventListener('click', () => { if (this.index > 0) this.navigate(-1); });
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
            </section>
            <section class="profile-panel" data-panel="4" aria-labelledby="profileSecurityTitle" aria-hidden="true" inert>
                <h2 id="profileSecurityTitle">Security</h2>
                <p class="profile-panel-intro">Strengthen this account's sign-in posture with two-factor authentication and keep credentials current.</p>
                <div class="profile-setting-row">
                    <span><strong>Two-factor authentication</strong><small>${this.security2faEnabled ? 'Enabled - a second factor is required at sign-in.' : 'Disabled - sign-in currently uses only a password.'}</small></span>
                    <button type="button" class="profile-setting-action" data-profile-2fa-action>${Icons.render('shield-alt')}<span>${this.security2faEnabled ? 'Manage two-factor authentication' : 'Enable two-factor authentication'}</span></button>
                </div>
                <div class="profile-2fa-setup" hidden>
                    <p class="profile-detail">Scan the secret with your authenticator app, then enter the six-digit code to finish enabling.</p>
                    <p class="profile-detail">Secret: <span class="profile-2fa-secret"></span></p>
                    <label class="profile-field">Authenticator code<input type="text" inputmode="numeric" maxlength="6" class="profile-2fa-setup-code" aria-label="Two-factor authentication code"></label>
                    <button type="button" class="profile-2fa-setup-verify" disabled>Verify and enable</button>
                </div>
                <div class="profile-2fa-disable" hidden>
                    <label class="profile-field">Authenticator code<input type="text" inputmode="numeric" maxlength="6" class="profile-2fa-disable-code" aria-label="Two-factor authentication code"></label>
                    <button type="button" class="profile-2fa-disable-verify" disabled>Disable two-factor authentication</button>
                </div>
                <h3 class="profile-security-subhead">Change password</h3>
                <label class="profile-field">Current password<input type="password" autocomplete="current-password" class="profile-password-current" aria-label="Current password"></label>
                <label class="profile-field">New password<input type="password" autocomplete="new-password" class="profile-password-new" aria-label="New password"></label>
                <label class="profile-field">Confirm new password<input type="password" autocomplete="new-password" class="profile-password-confirm" aria-label="Confirm new password"></label>
                <button type="button" class="profile-password-save" disabled>Update password</button>
                <p class="profile-feedback" data-security-feedback aria-live="polite"></p>
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

        const securityPanel = this.body.querySelector('[data-panel="4"]');
        const securityFeedback = securityPanel.querySelector('.profile-security-feedback');
        const setSecurityFeedback = (message) => { if (securityFeedback) securityFeedback.textContent = message || ''; };
        const security2faAction = securityPanel.querySelector('[data-profile-2fa-action]');
        const security2faSetup = securityPanel.querySelector('.profile-2fa-setup');
        const security2faSetupCode = securityPanel.querySelector('.profile-2fa-setup-code');
        const security2faSetupVerify = securityPanel.querySelector('.profile-2fa-setup-verify');
        const security2faDisable = securityPanel.querySelector('.profile-2fa-disable');
        const security2faDisableCode = securityPanel.querySelector('.profile-2fa-disable-code');
        const security2faDisableVerify = securityPanel.querySelector('.profile-2fa-disable-verify');
        const securityPasswordCurrent = securityPanel.querySelector('.profile-password-current');
        const securityPasswordNew = securityPanel.querySelector('.profile-password-new');
        const securityPasswordConfirm = securityPanel.querySelector('.profile-password-confirm');
        const securityPasswordSave = securityPanel.querySelector('.profile-password-save');
        const refreshSecurity2FA = async () => {
            const status = await AuthAPI.get2FAStatus();
            this.security2faEnabled = !!status.enabled;
            const row = securityPanel.querySelector('.profile-setting-row');
            const small = row ? row.querySelector('small') : null;
            if (small) small.textContent = this.security2faEnabled ? 'Enabled - a second factor is required at sign-in.' : 'Disabled - sign-in currently uses only a password.';
            if (security2faAction) {
                security2faAction.disabled = false;
                security2faAction.innerHTML = `${Icons.render('shield-alt')}<span>${this.security2faEnabled ? 'Manage two-factor authentication' : 'Enable two-factor authentication'}</span>`;
            }
            if (security2faSetup) security2faSetup.hidden = !this.security2faEnabled;
            if (security2faDisable) security2faDisable.hidden = this.security2faEnabled;
            if (security2faSetupVerify) security2faSetupVerify.disabled = true;
            if (security2faDisableVerify) security2faDisableVerify.disabled = true;
        };

        security2faAction.addEventListener('click', async () => {
            if (this.securityBusy) return;
            this.securityBusy = true;
            setSecurityFeedback('');
            try {
                if (!this.security2faEnabled) {
                    const setup = await AuthAPI.setup2FA();
                    this.security2faSetup = setup;
                    security2faSetup.hidden = false;
                    security2faDisable.hidden = true;
                    const setupSecret = security2faSetup.querySelector('.profile-2fa-secret');
                    if (setupSecret) setupSecret.textContent = setup.secret || '';
                    security2faSetupCode.value = '';
                    security2faSetupVerify.disabled = true;
                    security2faAction.disabled = true;
                } else {
                    security2faDisable.hidden = false;
                    security2faSetup.hidden = true;
                    security2faDisableCode.value = '';
                    security2faDisableVerify.disabled = true;
                    security2faAction.disabled = true;
                }
            } catch (error) {
                setSecurityFeedback(error && error.message ? error.message : 'Two-factor authentication setup failed.');
            } finally {
                this.securityBusy = false;
            }
        });
        security2faSetupVerify.addEventListener('click', async () => {
            const code = security2faSetupCode.value.trim();
            if (this.securityBusy || code.length < 6) return;
            this.securityBusy = true;
            setSecurityFeedback('');
            try {
                const result = await AuthAPI.verify2FASetup(code);
                this.security2faEnabled = !!result.enabled;
                security2faSetup.hidden = true;
                security2faDisable.hidden = true;
                security2faSetupVerify.disabled = true;
                security2faAction.disabled = false;
                await refreshSecurity2FA();
            } catch (error) {
                setSecurityFeedback(error && error.message ? error.message : 'Two-factor verification failed.');
            } finally {
                this.securityBusy = false;
            }
        });
        security2faDisableVerify.addEventListener('click', async () => {
            const code = security2faDisableCode.value.trim();
            if (this.securityBusy || code.length < 6) return;
            this.securityBusy = true;
            setSecurityFeedback('');
            try {
                const result = await AuthAPI.disable2FA(code);
                this.security2faEnabled = !!result.enabled;
                security2faDisable.hidden = true;
                security2faDisableVerify.disabled = true;
                security2faAction.disabled = false;
                await refreshSecurity2FA();
            } catch (error) {
                setSecurityFeedback(error && error.message ? error.message : 'Two-factor disable failed.');
            } finally {
                this.securityBusy = false;
            }
        });
        security2faSetupCode.addEventListener('input', () => { if (security2faSetupVerify) security2faSetupVerify.disabled = security2faSetupCode.value.trim().length < 6; });
        security2faDisableCode.addEventListener('input', () => { if (security2faDisableVerify) security2faDisableVerify.disabled = security2faDisableCode.value.trim().length < 6; });
        securityPasswordCurrent.addEventListener('input', () => { setSecurityFeedback(''); });
        securityPasswordNew.addEventListener('input', () => { setSecurityFeedback(''); });
        securityPasswordConfirm.addEventListener('input', () => { setSecurityFeedback(''); });
        securityPasswordSave.addEventListener('click', async () => {
            if (this.securityBusy) return;
            const current = securityPasswordCurrent.value;
            const next = securityPasswordNew.value;
            const confirm = securityPasswordConfirm.value;
            if (!current || !next) { setSecurityFeedback('Enter your current password and a new password.'); return; }
            if (next.length < 8) { setSecurityFeedback('New password must be at least 8 characters.'); return; }
            if (next !== confirm) { setSecurityFeedback('New passwords do not match.'); return; }
            this.securityBusy = true;
            setSecurityFeedback('');
            try {
                const result = await AuthAPI.changePassword(current, next);
                securityPasswordCurrent.value = '';
                securityPasswordNew.value = '';
                securityPasswordConfirm.value = '';
                setSecurityFeedback(result && result.message ? result.message : 'Password updated successfully.');
            } catch (error) {
                setSecurityFeedback(error && error.message ? error.message : 'Password change failed.');
            } finally {
                this.securityBusy = false;
            }
        });

        this.refreshSecurity2FA();
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

    async refreshSecurity2FA() {
        const status = await AuthAPI.get2FAStatus();
        this.security2faEnabled = !!status.enabled;
        const panel = this.body.querySelector('[data-panel="4"]');
        if (!panel) return;
        const small = panel.querySelector('.profile-setting-row small');
        if (small) small.textContent = this.security2faEnabled ? 'Enabled - a second factor is required at sign-in.' : 'Disabled - sign-in currently uses only a password.';
        const action = panel.querySelector('[data-profile-2fa-action]');
        if (action) {
            action.disabled = false;
            action.innerHTML = `${Icons.render('shield-alt')}<span>${this.security2faEnabled ? 'Manage two-factor authentication' : 'Enable two-factor authentication'}</span>`;
        }
        const setup = panel.querySelector('.profile-2fa-setup');
        const disable = panel.querySelector('.profile-2fa-disable');
        if (setup) setup.hidden = !this.security2faEnabled;
        if (disable) disable.hidden = this.security2faEnabled;
        const setupVerify = panel.querySelector('.profile-2fa-setup-verify');
        const disableVerify = panel.querySelector('.profile-2fa-disable-verify');
        if (setupVerify) setupVerify.disabled = true;
        if (disableVerify) disableVerify.disabled = true;
    }

    showPanel(index, animate = true, direction = 1) {
        this.index = index;
        this.backBtn.hidden = index === 0;
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
        const width = Math.min(440, window.innerWidth - 32);
        this.dialog.style.width = `${width}px`;
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
        if (e.key === 'ArrowRight') { e.preventDefault(); this.navigate(1); return; }
        if (e.key === 'ArrowLeft') { e.preventDefault(); this.navigate(-1); return; }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    queueMicrotask(() => { window.profileDialog = new ProfileDialog(); });
});

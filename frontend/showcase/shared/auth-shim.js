/**
 * ==============================================================================
 * E-TICKETING — SHOWCASE LOGIN BRIDGE (online-only landing pages)
 * File: frontend/showcase/shared/auth-shim.js
 *
 * Reuses the EXACT offline login contract so a showcase page signs a user in
 * identically to /login (Phase 1 parity list):
 *   - POST /api/auth/login with payload { username, password, turnstile_token }
 *   - Tokens in sessionStorage: access_token / refresh_token / current_user
 *     (+ pending_token for the 2FA intermediate step)
 *   - Post-login redirect: role === 'admin' ? '/admin' : '/user'
 *   - SessionExpiredDialog registered with AuthAPI (same shared component both
 *     portals use) — never a forced logout/redirect on token expiry
 *   - Same 401/403/429 toasts: AuthAPI.login already maps 429 to the canonical
 *     "Too many login attempts. Please wait a moment..." message
 *   - Same client rate-limit guard as login.html (5 attempts / 60s, 30s block)
 *   - Turnstile lazily loaded from challenges.cloudflare.com ONLY when a site
 *     key is configured; empty key = dev mode (slot hidden, backend skips
 *     verification when CF_TURNSTILE_SECRET_KEY is unset) — mirror of login.html
 *
 * This file lives in frontend/showcase/ and is never precached by the service
 * worker. It may import shared files (api.js, session-dialog.js) — the reverse
 * (shared files importing showcase files) is forbidden.
 * ==============================================================================
 */
'use strict';

(function () {
    if (typeof AuthAPI === 'undefined') {
        console.error('showcase: AuthAPI (shared/js/api.js) must load before auth-shim.js');
        return;
    }

    // ---------- Session-expiry parity ----------
    // Same dialog component both portals use; never a forced logout/redirect.
    // No-op when the dialog script was not included with the template.
    if (typeof SessionExpiredDialog !== 'undefined' &&
            typeof SessionExpiredDialog.init === 'function') {
        SessionExpiredDialog.init();
    }

    // ---------- Rate limiting (identical logic to login.html) ----------
    var rateLimit = { attempts: 0, lastAttempt: 0, maxAttempts: 5, windowMs: 60000, blockUntil: 0 };
    function checkRateLimit(toast) {
        var now = Date.now();
        if (now - rateLimit.lastAttempt > rateLimit.windowMs) rateLimit.attempts = 0;
        if (now < rateLimit.blockUntil) {
            toast('Too many attempts. Try again in ' +
                Math.ceil((rateLimit.blockUntil - now) / 1000) + 's.', 'warning');
            return false;
        }
        if (rateLimit.attempts >= rateLimit.maxAttempts) {
            rateLimit.blockUntil = now + 30000;
            toast('Too many attempts. Please wait 30s before trying again.', 'warning');
            return false;
        }
        return true;
    }
    function registerAttempt() { rateLimit.attempts++; rateLimit.lastAttempt = Date.now(); }

    // ---------- Toast (self-contained; mirrors auth.js markup) ----------
    function toast(message, type, zone) {
        var root = zone || document.body;
        var el = document.createElement('div');
        el.className = 'showcase-auth-toast';
        el.setAttribute('data-type', type || 'error');
        el.textContent = message;
        el.setAttribute('role', 'alert');
        root.appendChild(el);
        setTimeout(function () {
            el.style.opacity = '0';
            setTimeout(function () { el.remove(); }, 250);
        }, 4200);
    }

    // ---------- Turnstile (parity with login.html §102-311) ----------
    // Lazy-loaded widget, only when a site key exists. Empty key = dev mode:
    // the reserved slot is hidden and no remote script is loaded.
    function initTurnstile(slot, key) {
        if (!key || !window.turnstile) return;
        try {
            window.turnstile.render(slot, {
                sitekey: key,
                theme: (function () {
                    try {
                        var t = document.querySelector('html').getAttribute('data-theme');
                        if (t && /dark/.test(t)) return 'dark';
                    } catch (e) { /* ignore */ }
                    return 'auto';
                })()
            });
        } catch (e) {
            slot.style.display = 'none';
        }
    }

    function loadTurnstile(slot, key) {
        if (!key) {
            slot.style.display = 'none';
            return;
        }
        if (window.turnstile) {
            initTurnstile(slot, key);
            return;
        }
        var prev = window.onloadTurnstileCallback;
        window.onloadTurnstileCallback = function () {
            initTurnstile(slot, key);
            if (typeof prev === 'function') prev();
        };
        var script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback';
        script.async = true;
        script.onerror = function () { slot.style.display = 'none'; };
        document.head.appendChild(script);
    }

    // ---------- Eye toggle (ICO1–ICO5 parity with the offline login) ----------
    function makeEyeToggle(button, input) {
        var shown = false;
        function sync() {
            input.type = shown ? 'text' : 'password';
            button.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
        }
        button.addEventListener('click', function () {
            shown = !shown;
            sync();
        });
        button.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                shown = !shown;
                sync();
            }
        });
        sync();
    }

    // ---------- Form rendering (single source of truth for every template) ----------
    var ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"' +
        ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/></svg>';
    var ICON_EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"' +
        ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M3 3l18 18"/><path d="M10.5 5.2A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17.5 17.5 0 0 1-3.2 3.9"/><path d="M6.4 6.4A17 17 0 0 0 2 12s3.5 7 10 7a10.6 10.6 0 0 0 4-.8"/></svg>';

    function renderLogin(zone, opts) {
        zone.innerHTML =
            '<form class="showcase-auth-form" novalidate>' +
                '<p class="showcase-auth-title" id="showcase-auth-title">' + (opts.title || 'Sign in') + '</p>' +
                '<div class="showcase-auth-field">' +
                    '<label for="showcase-auth-username">Username</label>' +
                    '<input id="showcase-auth-username" name="username" type="text" ' +
                        'autocomplete="username" placeholder="e.g. admin" />' +
                    '<p class="showcase-auth-error" id="showcase-auth-username-error" hidden role="alert"></p>' +
                '</div>' +
                '<div class="showcase-auth-field">' +
                    '<label for="showcase-auth-password">Password</label>' +
                    '<div class="showcase-auth-password-wrap">' +
                        '<input id="showcase-auth-password" name="password" type="password" ' +
                            'autocomplete="current-password" minlength="8" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" />' +
                        '<button type="button" class="showcase-auth-eye" id="showcase-auth-eye" ' +
                            'aria-label="Show password" tabindex="0">' + ICON_EYE + '</button>' +
                    '</div>' +
                    '<p class="showcase-auth-error" id="showcase-auth-password-error" hidden role="alert"></p>' +
                '</div>' +
                '<div id="showcase-auth-turnstile" class="showcase-auth-turnstile" style="min-height:65px"></div>' +
                '<button type="submit" class="showcase-auth-submit" id="showcase-auth-submit">' +
                    '<span id="showcase-auth-submit-label">Sign in</span>' +
                '</button>' +
                '<p class="showcase-auth-hint">Access your tickets with your e-ticketing account.</p>' +
                '<div class="showcase-auth-twofa" id="showcase-auth-twofa" hidden>' +
                    '<label for="showcase-auth-code">Verification code</label>' +
                    '<input id="showcase-auth-code" name="code" type="text" inputmode="numeric" ' +
                        'autocomplete="one-time-code" maxlength="6" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022" />' +
                    '<p class="showcase-auth-error" id="showcase-auth-code-error" hidden role="alert"></p>' +
                    '<button type="button" class="showcase-auth-submit" id="showcase-auth-verify">Verify code</button>' +
                    '<button type="button" class="showcase-auth-back" id="showcase-auth-back">Back to sign in</button>' +
                '</div>' +
            '</form>';

        var $ = function (id) { return zone.ownerDocument.getElementById(id); };
        var form = zone.querySelector('.showcase-auth-form');
        var twofa = $('showcase-auth-twofa');
        var turnstileSlot = $('showcase-auth-turnstile');
        var eye = $('showcase-auth-eye');
        var passwordInput = $('showcase-auth-password');

        makeEyeToggle(eye, passwordInput);
        loadTurnstile(turnstileSlot, opts.siteKey || '');

        function showFieldError(id, message) {
            var el = $(id);
            if (el) { el.textContent = message; el.removeAttribute('hidden'); }
        }
        function hideFieldError(id) {
            var el = $(id);
            if (el) el.setAttribute('hidden', '');
        }

        function setSubmitting(submitting) {
            var btn = $('showcase-auth-submit');
            btn.disabled = submitting;
            $('showcase-auth-submit-label').textContent = submitting ? 'Signing in\u2026' : 'Sign in';
        }

        function redirectHome(user) {
            toast('Signed in successfully. Redirecting\u2026', 'success', zone);
            setTimeout(function () {
                window.location.href = (user && user.role === 'admin') ? '/admin' : '/user';
            }, 800);
        }

        function showTwofa() {
            form.querySelector('.showcase-auth-title').textContent = 'Two-factor authentication';
            turnstileSlot.style.display = 'none';
            twofa.removeAttribute('hidden');
            $('showcase-auth-code').value = '';
            setTimeout(function () { $('showcase-auth-code').focus(); }, 50);
        }

        function hideTwofa() {
            sessionStorage.removeItem('pending_token');
            twofa.setAttribute('hidden', '');
            turnstileSlot.style.display = opts.siteKey ? '' : 'none';
            $('showcase-auth-title').textContent = opts.title || 'Sign in';
            form.querySelector('[name="password"]').focus();
        }

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            if (twofa.hasAttribute('hidden') === false) return;
            if (!checkRateLimit(function (m, t) { toast(m, t, zone); })) return;

            var username = $('showcase-auth-username').value.trim();
            var password = $('showcase-auth-password').value;
            var valid = true;
            if (!username) { showFieldError('showcase-auth-username-error', 'Username is required.'); valid = false; }
            else hideFieldError('showcase-auth-username-error');
            if (password.length < 8) { showFieldError('showcase-auth-password-error', 'Password must be at least 8 characters.'); valid = false; }
            else hideFieldError('showcase-auth-password-error');
            if (!valid) { registerAttempt(); toast('Check the highlighted fields and try again.', 'error', zone); return; }

            setSubmitting(true);
            AuthAPI.login(username, password)
                .then(function (user) {
                    setSubmitting(false);
                    rateLimit.attempts = 0;
                    if (user && user.needs2fa) { showTwofa(); return; }
                    redirectHome(user);
                })
                .catch(function (err) {
                    setSubmitting(false);
                    registerAttempt();
                    toast(err.message || 'Invalid credentials. Please try again.', 'error', zone);
                });
        });

        $('showcase-auth-verify').addEventListener('click', function () {
            var code = $('showcase-auth-code').value.trim();
            if (!/^\d{6}$/.test(code)) {
                showFieldError('showcase-auth-code-error', 'Enter the 6-digit code from your authenticator app.');
                return;
            }
            hideFieldError('showcase-auth-code-error');
            $('showcase-auth-verify').disabled = true;
            AuthAPI.login2fa(code)
                .then(function (user) {
                    $('showcase-auth-verify').disabled = false;
                    toast('Signed in successfully. Redirecting\u2026', 'success', zone);
                    setTimeout(function () {
                        window.location.href = (user && user.role === 'admin') ? '/admin' : '/user';
                    }, 800);
                })
                .catch(function (err) {
                    $('showcase-auth-verify').disabled = false;
                    toast(err.message || 'Invalid verification code. Please try again.', 'error', zone);
                    $('showcase-auth-code').value = '';
                    $('showcase-auth-code').focus();
                });
        });

        $('showcase-auth-back').addEventListener('click', hideTwofa);

        // Enter in the 2FA code input submits the verify action.
        $('showcase-auth-code').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                $('showcase-auth-verify').click();
            }
        });
    }

    window.ShowcaseAuth = {
        mount: function (zone, opts) {
            if (typeof zone === 'string') zone = document.getElementById(zone);
            if (!zone) return null;
            if (zone.getAttribute('data-showcase-auth') === '1') return null;
            zone.setAttribute('data-showcase-auth', '1');
            renderLogin(zone, opts || {});
            return zone;
        }
    };
})();
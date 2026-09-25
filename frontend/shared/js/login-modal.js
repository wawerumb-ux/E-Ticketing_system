/* ============================================================
   LOGIN MODAL — shared component
   File: frontend/shared/js/login-modal.js
   Host: frontend/landing.html (also reusable from any portal page).
   Depends on: api.js (AuthAPI), icons.js (Icons.render),
   password-field.js (PasswordField). All local — no remote assets (O1).
   Flow parity with frontend/login.html (A-list contract):
     - POST /api/auth/login via AuthAPI.login (api.js:40)
     - sessionStorage keys unchanged (access_token / refresh_token /
       current_user / pending_token)
     - 2FA embedded (stored pending_token -> AuthAPI.login2fa)
     - redirect: (role === 'admin') ? '/admin' : '/user'
     - 401 -> existing SessionExpiredDialog (no second dialog)
     - 403/429/network -> inline aria-live error region
   Trigger contract:
     - the modal is ALWAYS the sign-in surface on this page. Clicking any
       Sign-in CTA opens the popup; it never navigates to login.html.
     - offline: submit is disabled with an honest "Requires connection"
       label (O9) instead of navigating away.
   The modal never appears on login.html itself.
   ============================================================ */
(function () {
    'use strict';

    var MODAL_TITLE = 'Sign in to ICT Support Portal';
    var MODAL_DESC = 'Use your staff account to raise and track tickets.';
    var TRIGGER_SELECTOR = 'a[href="/login"], a[href="/login.html"]';

    var _modal = null;
    var _trigger = null;

    var $ = function (id) {
        return _modal && _modal.querySelector('#' + id);
    };

    function buildModal() {
        _modal = document.createElement('div');
        _modal.className = 'login-modal';
        _modal.id = 'loginModal';
        _modal.setAttribute('hidden', '');
        _modal.setAttribute('aria-hidden', 'true');
        _modal.innerHTML =
            '<div class="login-modal__backdrop" data-login-close></div>' +
            '<div class="login-modal__card" role="dialog" aria-modal="true" ' +
            'aria-labelledby="loginModalTitle" aria-describedby="loginModalDesc">' +
            '<button type="button" class="login-modal__close" id="loginModalClose" ' +
            'aria-label="Close sign-in dialog" data-login-close></button>' +
            /* ---- FRONT FACE: sign in ---- */
            '<div class="login-modal__face login-modal__face--front" id="loginModalFront">' +
            '<div class="login-modal__brand" aria-hidden="true" id="loginModalBrand"></div>' +
            '<h2 id="loginModalTitle">' + MODAL_TITLE + '</h2>' +
            '<p class="login-modal__desc" id="loginModalDesc">' + MODAL_DESC + '</p>' +
            '<div class="login-modal__turnstile" id="loginModalTurnstile" hidden></div>' +
            '<form id="loginModalForm" novalidate autocomplete="on">' +
            '  <div class="form-group">' +
            '    <label for="loginModalUsername">Username</label>' +
            '    <div class="auth-input-wrap">' +
            '      <svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
            'stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/>' +
            '<path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>' +
            '      <input type="text" id="loginModalUsername" name="username" ' +
            'autocomplete="username" placeholder="Your username">' +
            '    </div>' +
            '  </div>' +
            '  <div class="form-group">' +
            '    <label for="loginModalPassword">Password</label>' +
            '    <div class="password-field" data-password-field data-mode="enter">' +
            '      <svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
            'stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" ' +
            'height="9" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>' +
            '      <input type="password" id="loginModalPassword" name="password" ' +
            'autocomplete="current-password" placeholder="Your password">' +
            '    </div>' +
            '    <p class="login-modal__caps" id="loginModalCaps" role="status" ' +
            'aria-live="polite" hidden>Caps Lock is on</p>' +
            '  </div>' +
            '  <p class="login-modal__error" id="loginModalError" role="alert" ' +
            'aria-live="polite" hidden></p>' +
            '  <div class="login-modal__actions">' +
            '    <button type="submit" class="btn btn-primary login-modal__submit" ' +
            'id="loginModalSubmit">Sign in</button>' +
            '  </div>' +
            '</form>' +
            '<form id="loginModalTwofaForm" hidden novalidate>' +
            '  <div class="form-group">' +
            '    <label for="loginModalCode">Verification code</label>' +
            '    <input type="tel" class="auth-input-otp" inputmode="numeric" ' +
            'pattern="[0-9]*" maxlength="6" id="loginModalCode" ' +
            'autocomplete="one-time-code" placeholder="6-digit code">' +
            '    <p class="login-modal__error" id="loginModalTwofaError" role="alert" ' +
            'aria-live="polite" hidden></p>' +
            '  </div>' +
            '  <div class="login-modal__actions">' +
            '    <button type="submit" class="btn btn-primary login-modal__submit" ' +
            'id="loginModalTwofaSubmit">Verify</button>' +
            '    <button type="button" class="login-modal__back" ' +
            'id="loginModalTwofaBack">Back to sign-in</button>' +
            '  </div>' +
            '</form>' +
            '<div class="login-modal__alt">' +
            '<span>New here?</span>' +
            '<button type="button" id="loginModalCreate">Create an account</button>' +
            '</div>' +
            '</div>' +
            /* ---- BACK FACE: create account ---- */
            '<div class="login-modal__face login-modal__face--back" id="loginModalBack" ' +
            'inert aria-hidden="true">' +
            '<h2 id="loginModalRegisterTitle">Create your account</h2>' +
            '<p class="login-modal__desc" id="loginModalRegisterDesc">' +
            'Set up a staff account to raise and track tickets.' +
            '</p>' +
            '<form id="loginModalRegisterForm" novalidate autocomplete="on">' +
            '  <div class="form-group">' +
            '    <label for="loginModalRegisterUsername">Username</label>' +
            '    <div class="auth-input-wrap">' +
            '      <svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
            'stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/>' +
            '<path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>' +
            '      <input type="text" id="loginModalRegisterUsername" name="username" ' +
            'autocomplete="username" minlength="2" placeholder="Your username">' +
            '    </div>' +
            '  </div>' +
            '  <div class="form-group">' +
            '    <label for="loginModalRegisterEmail">Email address</label>' +
            '    <div class="auth-input-wrap">' +
            '      <svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
            'stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" ' +
            'height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>' +
            '      <input type="email" id="loginModalRegisterEmail" name="email" ' +
            'autocomplete="email" placeholder="you@example.com">' +
            '    </div>' +
            '  </div>' +
            '  <div class="form-group">' +
            '    <label for="loginModalRegisterPassword">Create a password</label>' +
            '    <div class="password-field" data-password-field data-mode="create" data-length="16">' +
            '      <svg class="auth-input-icon" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
            'stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" ' +
            'height="9" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>' +
            '      <input type="password" id="loginModalRegisterPassword" name="password" ' +
            'autocomplete="new-password" minlength="8" placeholder="Your password">' +
            '    </div>' +
            '  </div>' +
            '  <label class="terms-row">' +
            '    <input type="checkbox" id="loginModalRegisterTerms">' +
            '    <span>I agree to the Terms of Service and Privacy Policy.</span>' +
            '  </label>' +
            '  <p class="login-modal__error" id="loginModalRegisterError" role="alert" ' +
            'aria-live="polite" hidden></p>' +
            '  <p class="login-modal__success" id="loginModalRegisterSuccess" role="status" ' +
            'aria-live="polite" hidden></p>' +
            '  <div class="login-modal__actions">' +
            '    <button type="submit" class="btn btn-primary login-modal__submit" ' +
            'id="loginModalRegisterSubmit">Create account</button>' +
            '  </div>' +
            '</form>' +
            '<p class="login-modal__alt">' +
            '<button type="button" id="loginModalBackToSignin">Back to sign in</button>' +
            '</p>' +
            '</div>' +
            '</div>';

        document.body.appendChild(_modal);
        _modal.addEventListener('click', function (e) {
            if (e.target.closest('[data-login-close]')) close();
        });
        _modal.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { close(); return; }
            if (e.key !== 'Tab') return;
            /* Only tab through the ACTIVE face: the hidden face is `inert`,
               and hidden (2FA) forms are display:none — both must be skipped
               so focus never lands invisible (MOD5). */
            var els = Array.prototype.filter.call(
                _modal.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])'),
                function (el) {
                    if (el.closest('[inert]')) return false;
                    var f = el.closest('form');
                    if (f && f.hasAttribute('hidden')) return false;
                    return true;
                });
            if (!els.length) return;
            var first = els[0];
            var last = els[els.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        });

        $('loginModalBrand').innerHTML =
            '<img class="login-modal__logo" src="/shared/assets/logo/nakuru%20county%20logo.png" alt="">';
        wireToggle();
        wireCapsLock();
        wireForm();
        wireTwofa();
        wireRegister();
        PasswordField.refresh(_modal);
    }

    /* Backdrop / brand area is the close zone only for [data-login-close];
       label clicks intentionally do not close. */

    function wireToggle() { /* handled by PasswordField */ }

    function wireCapsLock() {
        var input = $('loginModalPassword');
        var caps = $('loginModalCaps');
        function syncCaps(e) {
            var on = !!e.getModifierState && e.getModifierState('CapsLock');
            caps.toggleAttribute('hidden', !on);
        }
        input.addEventListener('keyup', syncCaps);
        input.addEventListener('keydown', syncCaps);
    }

    function setError(id, message) {
        var el = $(id);
        el.textContent = message || '';
        el.toggleAttribute('hidden', !message);
    }

    function setSubmitting(buttonId, submitting, label) {
        var btn = $(buttonId);
        btn.disabled = submitting;
        if (submitting) {
            btn.dataset.label = label || btn.textContent;
            btn.innerHTML = Icons.render('spinner', { state: 'loading' }) + '<span>' + label + '</span>';
        } else {
            if (btn.dataset.label) { btn.textContent = btn.dataset.label; delete btn.dataset.label; }
        }
    }

    function open(trigger) {
        /* AuthAPI is a top-level const in api.js — NOT visible as
           window.AuthAPI (classic scripts). Test the lexical binding
           directly, the same way the portals do. */
        if (typeof AuthAPI === 'undefined' || typeof Icons === 'undefined' ||
                typeof PasswordField === 'undefined') {
            /* Dependencies are always loaded on this page (landing.html).
               Defensive: never navigate away — stay on the landing page. */
            return;
        }
        _trigger = trigger || document.activeElement;
        window.removeEventListener('online', updateOfflineLabel);
        window.removeEventListener('offline', updateOfflineLabel);
        window.addEventListener('online', updateOfflineLabel);
        window.addEventListener('offline', updateOfflineLabel);
        var submit = $('loginModalSubmit');
        submit.disabled = !navigator.onLine;
        resetFlip();
        updateOfflineLabel();
        $('loginModalForm').reset();
        $('loginModalTwofaForm').setAttribute('hidden', '');
        $('loginModalForm').removeAttribute('hidden');
        setError('loginModalError', '');
        setError('loginModalTwofaError', '');
        showTurnstile();
        _modal.removeAttribute('hidden');
        _modal.setAttribute('aria-hidden', 'false');
        _modal.classList.add('is-open');
        if (document.activeElement) document.activeElement.blur();
        setTimeout(function () { $('loginModalUsername').focus(); }, 0);
    }

    function updateOfflineLabel() {
        var btn = $('loginModalSubmit');
        var regBtn = $('loginModalRegisterSubmit');
        if (navigator.onLine) {
            btn.disabled = false;
            btn.textContent = btn.dataset.offlineLabel || 'Sign in';
            if (btn.dataset.offlineLabel) delete btn.dataset.offlineLabel;
            if (regBtn) {
                regBtn.disabled = false;
                regBtn.textContent = regBtn.dataset.offlineLabel || 'Create account';
                if (regBtn.dataset.offlineLabel) delete regBtn.dataset.offlineLabel;
            }
        } else {
            btn.dataset.offlineLabel = 'Sign in';
            btn.disabled = true;
            btn.innerHTML = Icons.render('wifi', {}) + '<span>Requires connection</span>';
            if (regBtn) {
                regBtn.dataset.offlineLabel = 'Create account';
                regBtn.disabled = true;
                regBtn.innerHTML = Icons.render('wifi', {}) + '<span>Requires connection</span>';
            }
        }
    }

    function reducedMotion() {
        return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    /* Force the card back to the sign-in face (used on every open so a
       close/reopen never starts on the register side). */
    function resetFlip() {
        var card = _modal.querySelector('.login-modal__card');
        if (!card) return;
        card.classList.remove('is-register');
        $('loginModalFront').removeAttribute('inert');
        $('loginModalFront').setAttribute('aria-hidden', 'false');
        $('loginModalBack').setAttribute('inert', '');
        $('loginModalBack').setAttribute('aria-hidden', 'true');
        card.setAttribute('aria-labelledby', 'loginModalTitle');
        card.setAttribute('aria-describedby', 'loginModalDesc');
        $('loginModalRegisterForm').reset();
        setError('loginModalRegisterError', '');
        $('loginModalRegisterSuccess').setAttribute('hidden', '');
    }

    /* Spin the card to the register face (or back to sign in). The inactive
       face becomes inert/aria-hidden so it drops out of Tab and AT parsing;
       dialog labelling follows the face that is showing (MOD5/MOD6). */
    function flipTo(side) {
        var card = _modal.querySelector('.login-modal__card');
        if (!card) return;
        var toRegister = side === 'register';
        var front = $('loginModalFront');
        var back = $('loginModalBack');
        card.classList.toggle('is-register', toRegister);
        front.toggleAttribute('inert', toRegister);
        front.setAttribute('aria-hidden', toRegister ? 'true' : 'false');
        back.toggleAttribute('inert', !toRegister);
        back.setAttribute('aria-hidden', toRegister ? 'false' : 'true');
        card.setAttribute('aria-labelledby', toRegister ? 'loginModalRegisterTitle' : 'loginModalTitle');
        card.setAttribute('aria-describedby', toRegister ? 'loginModalRegisterDesc' : 'loginModalDesc');
        if (toRegister) setError('loginModalRegisterError', '');
        var target = toRegister ? $('loginModalRegisterUsername') : $('loginModalPassword');
        window.setTimeout(function () {
            if (target && target.focus) target.focus();
        }, reducedMotion() ? 0 : 560);
    }

    function close(skipFocusReturn) {
        if (!_modal || _modal.hasAttribute('hidden')) return;
        _modal.classList.add('is-closing');
        var done = function () {
            _modal.classList.remove('is-open', 'is-closing');
            _modal.setAttribute('hidden', '');
            _modal.setAttribute('aria-hidden', 'true');
            if (!skipFocusReturn && _trigger && _trigger.focus) _trigger.focus();
        };
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            done();
        } else {
            setTimeout(done, 180);
        }
    }

    function showTurnstile() {
        var wrap = $('loginModalTurnstile');
        if (!wrap) return;
        var siteKey = (window.CF_TURNSTILE_SITE_KEY || '').trim();
        if (!siteKey) {
            /* Dev mode: no site key configured (login.html:314-318). The
               backend skips verification when CF_TURNSTILE_SECRET_KEY is
               empty, so hide the reserved slot entirely. */
            wrap.setAttribute('hidden', '');
            return;
        }
        wrap.removeAttribute('hidden');
        if (typeof window.turnstile !== 'undefined') {
            try { window.turnstile.render(wrap, { sitekey: siteKey }); }
            catch (e) { wrap.setAttribute('hidden', ''); }
            return;
        }
        /* Mirror login.html:307-313 — lazy-load the managed widget only when
           a site key is configured (narrow, documented O1 exception; the
           validator reports it as a login-surface warning, not an error). */
        window.onloadTurnstileCallback = function () {
            try { window.turnstile.render(wrap, { sitekey: siteKey }); }
            catch (e) { wrap.setAttribute('hidden', ''); }
        };
        var script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback';
        script.async = true;
        script.onerror = function () { wrap.setAttribute('hidden', ''); };
        document.head.appendChild(script);
    }

    function handleLoginError(err) {
        var msg = (err && err.message) || 'Invalid credentials. Please try again.';
        if (/expired|unauthori|session/i.test(msg)) {
            close(true);
            if (typeof SessionExpiredDialog !== 'undefined' && SessionExpiredDialog.show) {
                SessionExpiredDialog.show();
            } else {
                /* No dialog available on this page — keep the popup closed and
                   show the reason on the page rather than navigating away. */
                setError('loginModalError', msg);
            }
            return;
        }
        setError('loginModalError', msg);
        var pw = $('loginModalPassword');
        if (pw) { pw.focus(); pw.select(); }
    }

    function wireForm() {
        $('loginModalForm').addEventListener('submit', function (e) {
            e.preventDefault();
            if (!navigator.onLine) { setError('loginModalError', 'Requires a connection. Check your network and try again.'); return; }
            var username = $('loginModalUsername').value.trim();
            var password = $('loginModalPassword').value;
            if (!username) { setError('loginModalError', 'Username is required.'); return; }
            if (!password || password.length < 8) { setError('loginModalError', 'Password must be at least 8 characters.'); return; }
            setError('loginModalError', '');
            setSubmitting('loginModalSubmit', true, 'Signing in…');
            AuthAPI.login(username, password)
                .then(function (user) {
                    setSubmitting('loginModalSubmit', false);
                    if (user && user.needs2fa) {
                        $('loginModalForm').setAttribute('hidden', '');
                        $('loginModalTwofaForm').removeAttribute('hidden');
                        setError('loginModalTwofaError', '');
                        setTimeout(function () { $('loginModalCode').focus(); }, 0);
                        return;
                    }
                    if (user && user.role) {
                        goHome(user.role);
                    }
                })
                .catch(function (err) {
                    setSubmitting('loginModalSubmit', false);
                    handleLoginError(err);
                });
        });

        var username = $('loginModalUsername');
        username.addEventListener('input', function () { setError('loginModalError', ''); });
        $('loginModalPassword').addEventListener('input', function () { setError('loginModalError', ''); });
    }

    function wireTwofa() {
        $('loginModalTwofaForm').addEventListener('submit', function (e) {
            e.preventDefault();
            var code = $('loginModalCode').value.trim();
            if (!/^\d{6}$/.test(code)) { setError('loginModalTwofaError', 'Enter the 6-digit code from your authenticator app.'); return; }
            setError('loginModalTwofaError', '');
            setSubmitting('loginModalTwofaSubmit', true, 'Verifying…');
            AuthAPI.login2fa(code)
                .then(function (user) {
                    setSubmitting('loginModalTwofaSubmit', false);
                    if (user && user.role) goHome(user.role);
                })
                .catch(function (err) {
                    setSubmitting('loginModalTwofaSubmit', false);
                    setError('loginModalTwofaError', (err && err.message) || 'Invalid verification code. Please try again.');
                    $('loginModalCode').value = '';
                    $('loginModalCode').focus();
                });
        });

        $('loginModalTwofaBack').addEventListener('click', function () {
            sessionStorage.removeItem('pending_token');
            $('loginModalTwofaForm').setAttribute('hidden', '');
            $('loginModalForm').removeAttribute('hidden');
            setError('loginModalTwofaError', '');
            $('loginModalPassword').focus();
        });
    }

    function wireRegister() {
        $('loginModalCreate').addEventListener('click', function () {
            setError('loginModalError', '');
            flipTo('register');
        });
        $('loginModalBackToSignin').addEventListener('click', function () {
            flipTo('signin');
        });
        $('loginModalRegisterTerms').addEventListener('change', function () {
            setError('loginModalRegisterError', '');
        });
        ['loginModalRegisterUsername', 'loginModalRegisterEmail', 'loginModalRegisterPassword']
            .forEach(function (id) {
                $(id).addEventListener('input', function () { setError('loginModalRegisterError', ''); });
            });
        $('loginModalRegisterForm').addEventListener('submit', function (e) {
            e.preventDefault();
            if (!navigator.onLine) {
                setError('loginModalRegisterError', 'Requires a connection. Check your network and try again.');
                return;
            }
            var username = $('loginModalRegisterUsername').value.trim();
            var email = $('loginModalRegisterEmail').value.trim();
            var password = $('loginModalRegisterPassword').value;
            var terms = $('loginModalRegisterTerms').checked;
            var msg = '';
            if (!username || username.length < 2) {
                msg = 'Username must be at least 2 characters.';
            } else if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(username)) {
                msg = 'Username can only contain letters, numbers, dots, underscores and hyphens.';
            } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                msg = 'Enter a valid email address.';
            } else if (password.length < 8) {
                msg = 'Password must be at least 8 characters.';
            } else if (!terms) {
                msg = 'Accept the terms to continue.';
            }
            if (msg) { setError('loginModalRegisterError', msg); return; }
            setError('loginModalRegisterError', '');
            $('loginModalRegisterSuccess').setAttribute('hidden', '');
            setSubmitting('loginModalRegisterSubmit', true, 'Creating account\u2026');
            AuthAPI.register(username, email, password)
                .then(function (data) {
                    setSubmitting('loginModalRegisterSubmit', false);
                    $('loginModalRegisterSuccess').textContent =
                        (data && data.message) || 'Account created! You can now sign in.';
                    $('loginModalRegisterSuccess').removeAttribute('hidden');
                    window.setTimeout(function () {
                        $('loginModalRegisterSuccess').setAttribute('hidden', '');
                        $('loginModalRegisterForm').reset();
                        $('loginModalUsername').value = username;
                        flipTo('signin');
                    }, 1400);
                })
                .catch(function (err) {
                    setSubmitting('loginModalRegisterSubmit', false);
                    setError('loginModalRegisterError',
                        (err && err.message) || 'Registration failed. Contact an administrator.');
                });
        });
    }

    function goHome(role) {
        window.location.href = (role === 'admin') ? '/admin' : '/user';
    }

    function wireTriggers() {
        document.addEventListener('click', function (e) {
            var trigger = e.target.closest(TRIGGER_SELECTOR);
            if (!trigger) return;
            if (_modal && !_modal.hasAttribute('hidden') && _modal.contains(trigger)) return;
            /* Sign-in is a popup on this page — never navigate to login.html,
               online or offline. Offline state is shown inside the modal. */
            e.preventDefault();
            e.stopPropagation();
            open(trigger);
        });
    }

    function init() {
        if (!document.body) { document.addEventListener('DOMContentLoaded', init); return; }
        if (!document.querySelector('#loginModal')) buildModal();
        wireTriggers();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
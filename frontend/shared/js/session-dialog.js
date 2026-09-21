/**
 * ==============================================================================
 * E-TICKETING SYSTEM — SHARED SESSION EXPIRED DIALOG
 * File: frontend/shared/js/session-dialog.js
 * Description: Canonical session expired modal and focus management.
 * Deduplicated from user/js/app.js and admin/js/app.js.
 * Registered with AuthAPI so an expired/revoked token surfaces "Session expired"
 * without destructive page redirects or state loss.
 * ==============================================================================
 */
'use strict';

var SessionExpiredDialog = (function () {
    var _dialog = null;
    var _previousFocus = null;

    function show() {
        var previous = document.activeElement;
        if (_dialog) {
            _dialog.style.display = 'block';
            _focus(previous);
            return;
        }

        var dialog = document.createElement('div');
        dialog.className = 'modal';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'sessionExpiredTitle');
        dialog.setAttribute('aria-describedby', 'sessionExpiredMessage');

        var content = document.createElement('div');
        content.className = 'modal-content';
        content.style.maxWidth = '420px';

        var title = document.createElement('h3');
        title.id = 'sessionExpiredTitle';
        title.textContent = 'Session expired';

        var message = document.createElement('p');
        message.id = 'sessionExpiredMessage';
        message.textContent = 'Your session has expired — please log in again to continue.';

        var actions = document.createElement('div');
        actions.className = 'modal-actions';

        var goLogin = document.createElement('button');
        goLogin.id = 'sessionExpiredGoLogin';
        goLogin.className = 'btn btn-primary';
        goLogin.textContent = 'Go to Login';
        goLogin.addEventListener('click', function () {
            if (typeof AuthAPI !== 'undefined' && typeof AuthAPI.logout === 'function') {
                AuthAPI.logout();
            } else {
                window.location.href = '/login.html';
            }
        });

        var stay = document.createElement('button');
        stay.id = 'sessionExpiredStay';
        stay.className = 'btn btn-secondary';
        stay.textContent = 'Stay here';
        stay.addEventListener('click', function () {
            close(previous);
        });

        actions.appendChild(goLogin);
        actions.appendChild(stay);
        content.appendChild(title);
        content.appendChild(message);
        content.appendChild(actions);
        dialog.appendChild(content);
        document.body.appendChild(dialog);
        _dialog = dialog;

        dialog.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                close(previous);
                return;
            }
            if (e.key !== 'Tab') return;
            var focusables = dialog.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])');
            if (focusables.length === 0) return;
            var first = focusables[0];
            var last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        });

        _focus(previous);
    }

    function _focus(previous) {
        _previousFocus = previous;
        var goLogin = document.getElementById('sessionExpiredGoLogin');
        if (goLogin && typeof goLogin.focus === 'function') goLogin.focus();
    }

    function close(previous) {
        if (!_dialog) return;
        _dialog.style.display = 'none';
        var target = previous || _previousFocus;
        if (target && typeof target.focus === 'function') target.focus();
    }

    function init() {
        if (typeof AuthAPI !== 'undefined' && typeof AuthAPI.setOnSessionExpired === 'function') {
            AuthAPI.setOnSessionExpired(show);
        }
    }

    return {
        init: init,
        show: show,
        close: close
    };
})();

/* shared/js/password-field.js — offline password field component.
   Provides: window.PasswordField.
   Patterns built in (all local, no network):
     - visibility toggle (eye / eye-slash) inside the field, ICO1–ICO5
     - live strength meter on input (real length/class check, small
       common-password list, no fake intelligence)
     - strong-password generator via crypto.getRandomValues()
     - copy-to-clipboard with visible confirmation
   Declarative HTML:
     <div class="password-field" data-password-field data-mode="create" data-length="16">
       <label for="id">Password</label>
       <input type="password" id="id" ...>
     </div>
   mode: create → toggle + meter + generate/copy; confirm → toggle only;
   enter  → toggle only.
   Depends on: Icons.render (shared/js/icons.js). */

(function () {
    "use strict";

    var COMMON = [
        'password', '123456', '12345678', 'qwerty', 'abc123', 'monkey',
        '1234567', 'letmein', 'trustno1', 'dragon', 'baseball', 'iloveyou',
        'master', 'sunshine', 'ashley', 'bailey', 'passw0rd', 'shadow',
        '123123', '654321', 'superman', 'qazwsx', 'michael', 'football',
        'password1', '123456789', '1234567890', 'welcome', 'ninja', 'mustang',
        'password123', 'lovely', 'whatever', 'zaq1zaq1', 'hello', 'charlie',
        'donald', 'password12', 'starwars', 'login', 'princess', 'password!',
        'flower', 'chester', 'jordan1', 'summer', 'qwerty123', 'hunter',
        'iloveu', 'tigger', 'batman', 'sunmoon', 'xcvbnm', '1qaz2wsx',
        'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '111111', '222222', '000000',
        '88888888', '1234', '12345', '54321', 'qwe123', 'manager', 'photoshop',
        'nimda', 'hello123', 'letmein1', 'iloveyou1', 'secret', 'dragon1',
        'trustno1!', 'abcd1234', 'a1b2c3', 'azerty', 'passpass', 'zaq12wsx',
        'welcome1', 'password2', 'solo', 'shadow1', 'trainer', 'killer',
        'test', 'testing', 'demo', 'george', 'jessica', 'jennifer',
        'daniel', 'alexis', 'andrew', 'joshua', 'jasmine', 'maggie'
    ];

    var CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*()-_=+[]{};:,./?";
    var COLORS = {
        danger: 'var(--danger-text, var(--danger, #dc2626))',
        warning: 'var(--warning, #b45309)',
        success: 'var(--success, #15803d)'
    };

    function strengthOf(value) {
        var v = (value || '').trim();
        var neutral = { score: 0, text: 'Use at least 8 characters.', color: '', percent: 0 };

        if (v.length === 0) return neutral;

        if (COMMON.indexOf(v.toLowerCase()) !== -1) {
            return {
                score: 0,
                text: 'This is a commonly used password \u2014 choose something unique.',
                color: COLORS.danger,
                percent: 0
            };
        }

        var score = 0;
        if (v.length >= 8) score++;
        if (v.length >= 12) score++;
        if (v.length >= 16) score++;
        if (/[a-z]/.test(v)) score++;
        if (/[A-Z]/.test(v)) score++;
        if (/[0-9]/.test(v)) score++;
        if (/[^A-Za-z0-9]/.test(v)) score++;

        if (score <= 2) {
            return { score: score, text: 'Weak \u2014 add an uppercase letter, a number, and a symbol.', color: COLORS.danger, percent: score / 7 * 100 };
        }
        if (score <= 4) {
            return { score: score, text: 'Fair \u2014 make it at least 12 characters for a stronger password.', color: COLORS.warning, percent: score / 7 * 100 };
        }
        if (score <= 6) {
            return { score: score, text: 'Strong \u2014 keep it long, and don\u2019t reuse it elsewhere.', color: COLORS.success, percent: score / 7 * 100 };
        }
        return { score: 7, text: 'Very strong. Excellent.', color: COLORS.success, percent: 100 };
    }

    function randomIndex(max) {
        var limit = 0x100000000 - (0x100000000 % max);
        var x;
        do {
            x = crypto.getRandomValues(new Uint32Array(1))[0];
        } while (x >= limit);
        return x % max;
    }

    function generate(length) {
        var out = '';
        for (var i = 0; i < length; i++) out += CHARS[randomIndex(CHARS.length)];
        return out;
    }

    function wire(root) {
        var els = root.querySelectorAll('[data-password-field]');
        for (var i = 0; i < els.length; i++) wireField(els[i]);
    }

    function wireField(el) {
        if (el.dataset.pwBound) return;
        el.dataset.pwBound = '1';

        var input = el.querySelector('input[type="password"]');
        if (!input) return;

        var row = document.createElement('span');
        row.className = 'password-field__row';
        if (input.parentNode) {
            input.parentNode.insertBefore(row, input);
            row.appendChild(input);
        }
        var icon = el.querySelector('.auth-input-icon');
        if (icon && icon.parentNode !== row) row.insertBefore(icon, row.firstChild);

        var mode = (el.getAttribute('data-mode') || 'enter').toLowerCase();
        var length = parseInt(el.getAttribute('data-length') || '16', 10);

        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'password-field__toggle';
        toggle.setAttribute('aria-label', 'Show password');
        toggle.setAttribute('aria-pressed', 'false');
        toggle.setAttribute('data-visible', 'false');
        toggle.innerHTML = Icons.render('eye');
        row.appendChild(toggle);

        toggle.addEventListener('click', function () {
            var show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            toggle.setAttribute('data-visible', String(show));
            toggle.setAttribute('aria-pressed', String(show));
            toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
            toggle.innerHTML = Icons.render(show ? 'eye-slash' : 'eye');
        });

        function resetVisibility() {
            input.type = 'password';
            toggle.setAttribute('data-visible', 'false');
            toggle.setAttribute('aria-pressed', 'false');
            toggle.setAttribute('aria-label', 'Show password');
            toggle.innerHTML = Icons.render('eye');
        }

        var form = input.form;
        if (form) form.addEventListener('reset', resetVisibility);

        if (mode !== 'create') return;

        var meter = document.createElement('div');
        meter.className = 'password-field__meter';
        meter.innerHTML =
            '<div class="password-field__track" aria-hidden="true">' +
            '<div class="password-field__bar"></div></div>' +
            '<p class="password-field__status" role="status">Use at least 8 characters.</p>';
        el.appendChild(meter);

        var bar = meter.querySelector('.password-field__bar');
        var status = meter.querySelector('.password-field__status');

        var actions = document.createElement('div');
        actions.className = 'password-field__actions';
        actions.innerHTML =
            '<button type="button" class="password-field__generate" aria-label="Generate strong password">' +
            Icons.render('key') + '<span>Generate strong password</span></button>' +
            '<button type="button" class="password-field__copy" hidden aria-label="Copy password">' +
            Icons.render('save') + '<span>Copy</span></button>';
        el.appendChild(actions);

        var genBtn = actions.querySelector('.password-field__generate');
        var copyBtn = actions.querySelector('.password-field__copy');
        var copyTimer = null;

        function update() {
            var s = strengthOf(input.value);
            bar.style.width = s.percent + '%';
            bar.style.background = s.color;
            status.textContent = s.text;
            status.style.color = s.color;
            copyBtn.hidden = !input.value;
            if (!input.value) resetCopy();
        }

        input.addEventListener('input', update);

        genBtn.addEventListener('click', function () {
            input.value = generate(length);
            input.type = 'text';
            toggle.setAttribute('data-visible', 'true');
            toggle.setAttribute('aria-pressed', 'true');
            toggle.setAttribute('aria-label', 'Hide password');
            toggle.innerHTML = Icons.render('eye-slash');
            genBtn.innerHTML = Icons.render('sync-alt') + '<span>Regenerate</span>';
            genBtn.setAttribute('aria-label', 'Regenerate password');
            update();
            input.focus();
        });

        function resetCopy() {
            clearTimeout(copyTimer);
            copyTimer = null;
            copyBtn.innerHTML = Icons.render('save') + '<span>Copy</span>';
            copyBtn.setAttribute('aria-label', 'Copy password');
        }

        if (form) form.addEventListener('reset', function () {
            resetVisibility();
            genBtn.innerHTML = Icons.render('key') + '<span>Generate strong password</span>';
            genBtn.setAttribute('aria-label', 'Generate strong password');
            update();
        });

        copyBtn.addEventListener('click', function () {
            var value = input.value;
            if (!value) return;

            function ok() {
                copyBtn.innerHTML = Icons.render('check') + '<span>Copied</span>';
                copyBtn.setAttribute('aria-label', 'Password copied');
                clearTimeout(copyTimer);
                copyTimer = setTimeout(resetCopy, 2000);
            }

            function fallback() {
                input.select();
                copyBtn.innerHTML = Icons.render('save') + '<span>Press Ctrl+C to copy.</span>';
                copyBtn.setAttribute('aria-label', 'Press Ctrl+C to copy');
                clearTimeout(copyTimer);
                copyTimer = setTimeout(resetCopy, 4000);
            }

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(value).then(ok, fallback);
            } else {
                fallback();
            }
        });

        update();
    }

    window.PasswordField = {
        init: function () { wire(document); },
        refresh: function (root) { wire(root || document); }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { wire(document); });
    } else {
        wire(document);
    }
})();
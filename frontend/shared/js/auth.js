/* shared/js/auth.js — offline-first auth-surface helpers.
   Provides: showToast, dismissToast, showFieldError / hideFieldError.
   Depends on: nothing (no Tailwind, no remote fonts, no CDN libs). */
(function () {
    "use strict";

    var $ = function (id) { return document.getElementById(id); };

    // ── Toasts ──────────────────────────────────────────────────────
    var TOAST_ICONS = {
        error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="7.5" x2="12" y2="13"/><circle cx="12" cy="16.5" r="0.75" fill="currentColor" stroke="none"/></svg>',
        success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>',
        warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l10 18H2L12 3z"/><line x1="12" y1="9.5" x2="12" y2="14"/><circle cx="12" cy="17" r="0.75" fill="currentColor" stroke="none"/></svg>',
        info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="7.5" r="0.75" fill="currentColor" stroke="none"/></svg>'
    };

    function dismissToast(el) {
        if (!el || !el.parentElement) return;
        el.style.opacity = "0";
        el.style.transform = "translateX(12px)";
        setTimeout(function () { el.remove(); }, 250);
    }

    window.showToast = function (message, type, duration) {
        duration = duration || 4200;
        type = type || "info";
        var container = $("toast-container");
        if (!container) return;

        var item = document.createElement("div");
        item.className = "auth-toast-item";
        item.setAttribute("data-type", type);
        item.style.opacity = "0";
        item.style.transform = "translateX(12px)";

        var iconSpan = document.createElement("span");
        iconSpan.className = "auth-toast-icon";
        iconSpan.innerHTML = TOAST_ICONS[type] || TOAST_ICONS.info;

        var msgP = document.createElement("p");
        msgP.className = "auth-toast-msg";
        msgP.textContent = message;

        var dismiss = document.createElement("button");
        dismiss.className = "auth-toast-dismiss";
        dismiss.setAttribute("aria-label", "Dismiss");
        dismiss.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l14 14M19 5L5 19"/></svg>';

        item.appendChild(iconSpan);
        item.appendChild(msgP);
        item.appendChild(dismiss);
        container.appendChild(item);

        requestAnimationFrame(function () {
            item.style.opacity = "1";
            item.style.transform = "translateX(0)";
        });

        dismiss.addEventListener("click", function () { dismissToast(item); });
        setTimeout(function () { dismissToast(item); }, duration);
    };

    // ── Field validation helpers ────────────────────────────────────
    window.showFieldError = function (id, message) {
        var el = $(id);
        if (el) { el.textContent = message; el.removeAttribute("hidden"); }
    };
    window.hideFieldError = function (id) {
        var el = $(id);
        if (el) el.setAttribute("hidden", "");
    };

    window._auth$ = $;
})();

/**
 * ==============================================================================
 * E-TICKETING SYSTEM — SHARED SIDEBAR MANAGER
 * File: frontend/shared/js/sidebar.js
 * Description: Canonical responsive sidebar and off-canvas navigation controller.
 * Deduplicated from user/js/app.js and admin/js/app.js.
 * Handles breakpoints (<=768 mobile drawer, 769-1024 overlay, >=1025 desktop rail/mini),
 * keyboard focus trapping, Escape dismissal, Alt+B / brand-label collapse on desktop,
 * and localStorage state persistence.
 * ==============================================================================
 */
'use strict';

var SidebarManager = (function () {
    var STATE_KEY = 'sidebar:state';
    var BREAKPOINT_MOBILE = 768;
    var BREAKPOINT_WIDE = 1025;
    var remembered = 'expanded';
    var drawerOpen = false;      // <=768px overlay drawer
    var expandedOverlay = false; // 769-1024px overlay
    var sidebarHover = false;    // transient rail expand while pointer/focus is on it

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
        el.classList.toggle('sidebar-mini', small ? false : (sidebarHover ? false : (wide ? remembered === 'mini' : !expandedOverlay)));
        var expanded = small ? drawerOpen : (!wide ? expandedOverlay : remembered === 'expanded');
        var btn = document.getElementById('toggleSidebar');
        var btnMobile = document.getElementById('toggleSidebarMobile');
        var labelBtn = document.getElementById('sidebarBrandLabel');
        if (btn) btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (btnMobile) btnMobile.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (labelBtn) {
            labelBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            labelBtn.setAttribute('aria-label', expanded ? 'Collapse sidebar' : 'Expand sidebar');
        }
        // Full state hides #toggleSidebar via CSS (Phase 3). Pull it out of the
        // tab order while invisible so it is never a hidden-but-focusable
        // control; the brand-label button and Alt+B are the keyboard paths
        // that replace it (Phase 2 proposal §5.2/§5.3).
        if (btn) btn.tabIndex = (wide && !el.classList.contains('sidebar-mini')) ? -1 : 0;
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
        var labelBtn = document.getElementById('sidebarBrandLabel');
        if (labelBtn) labelBtn.addEventListener('click', toggle);
        if (backdrop) backdrop.addEventListener('click', function () {
            closeOverlay(true);
        });

        // Transient expand-on-hover (Mini rail): while the pointer is over the
        // rail — or keyboard focus is inside it — the sidebar renders at full
        // Expanded width with the labels in-line, so a flyout never floats over
        // the content pane: the layout reflows out of the way instead. This is
        // never persisted and never overwrites the remembered state.
        var sidebarEl = document.getElementById('sidebar');
        function setSidebarHover(on) {
            if (isMobile()) return;
            if (sidebarHover === on) return;
            sidebarHover = on;
            apply();
        }
        if (sidebarEl) {
            sidebarEl.addEventListener('pointerenter', function () { setSidebarHover(true); });
            sidebarEl.addEventListener('pointerleave', function () { setSidebarHover(false); });
            sidebarEl.addEventListener('focusin', function () { setSidebarHover(true); });
            sidebarEl.addEventListener('focusout', function (e) {
                if (sidebarEl.contains(e.relatedTarget)) return;
                setSidebarHover(false);
            });
        }

        document.addEventListener('keydown', function (e) {
            var key = (e.key || '').toLowerCase();
            // Alt+B toggles Expanded <-> Mini on desktop wide. The mobile drawer
            // and 769-1024px overlay keep Escape/backdrop as their close paths,
            // so the shortcut is intentionally desktop-wide only.
            if (e.altKey && key === 'b') {
                if (isWide()) {
                    e.preventDefault();
                    if (!e.repeat) toggle();
                }
                return;
            }
            if (key !== 'escape') return;
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

    return {
        init: init,
        toggle: toggle,
        closeOverlay: closeOverlay,
        apply: apply,
        isMobile: isMobile,
        isWide: isWide
    };
})();

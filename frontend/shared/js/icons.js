// Shared inline SVG icon registry (offline-first icon system).
// 49 source icons (previously Font Awesome, font-awesome/6.4.0) plus the
// single new "target" glyph authorized for focus-mode-OFF -> ON (B2).
// Every glyph is a 24x24 viewBox stroked with currentColor so it inherits
// the surrounding element's font-size and color. No external font is used.
//
// Static-HTML icons use <i data-icon="…">, NOT <span>.
// Existing CSS rules are keyed to element selectors
// (.sidebar-nav i, .quick-action-btn i, .empty-state i,
// .ticket-table th i, .btn-icon i), and switching the
// element would silently break icon sizing at every
// breakpoint. Do not change the element.
//
// Usage:
//   - Static markup: <i data-icon="ticket-alt" aria-hidden="true"></i>
//   - JS templates : ${Icons.render('ticket-alt')}
//   - Loading      : Icons.render('spinner', { state: 'loading' })
//   - Labeled      : Icons.render('bell', { label: 'Notifications' })
//
// Icons.hydrate() is self-wired on DOMContentLoaded and is also invoked
// from both portal app.js files; it is idempotent, so the duplicate call
// is harmless.
(function () {
    'use strict';

    const ATTRS = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

    const ICONS = {
        'ticket-alt': { body: '<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="15" y1="5" x2="15" y2="10"/><circle cx="15" cy="12" r="1.6" fill="currentColor" stroke="none"/><line x1="15" y1="14" x2="15" y2="19"/>' },
        'ticket': { body: '<path d="M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v4h-1a2 2 0 0 0 0 4h1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4h1a2 2 0 0 0 0-4H4z"/>' },
        'chart-pie': { body: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="12" x2="12" y2="3"/><line x1="12" y1="12" x2="19" y2="12"/>' },
        'chart-line': { body: '<path d="M3 3v18h18"/><polyline points="7 15 11 11 14 14 18 9"/>' },
        'list': { body: '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="5" cy="18" r="1.2" fill="currentColor" stroke="none"/>' },
        'plus': { body: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>' },
        'plus-circle': { body: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="7.5" x2="12" y2="16.5"/><line x1="7.5" y1="12" x2="16.5" y2="12"/>' },
        'book': { body: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>' },
        'user': { body: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/>' },
        'user-plus': { body: '<circle cx="10" cy="8" r="4"/><path d="M2.5 20c0-3.2 3-5 7.5-5 1.2 0 2.3.2 3.3.6"/><line x1="19" y1="8" x2="23" y2="8"/><line x1="21" y1="6" x2="21" y2="10"/>' },
        'users': { body: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.2 3-5 6.5-5s6.5 1.8 6.5 5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M17.5 15.2c2.2.6 4 2.2 4 4.8"/>' },
        'bullhorn': { body: '<path d="M4 9h4l7-4v14l-7-4H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z"/><path d="M15.5 8.5a3.5 3.5 0 0 1 0 7"/><path d="M17.5 7a6 6 0 0 1 0 10"/>' },
        'plug': { body: '<path d="M9 2v5"/><path d="M15 2v5"/><rect x="7" y="7" width="10" height="6" rx="1"/><line x1="12" y1="13" x2="12" y2="19"/><circle cx="12" cy="20.5" r="1.5"/>' },
        'sliders-h': { body: '<line x1="3" y1="6" x2="21" y2="6"/><circle cx="14" cy="6" r="2" fill="currentColor" stroke="none"/><line x1="3" y1="12" x2="21" y2="12"/><circle cx="9" cy="12" r="2" fill="currentColor" stroke="none"/><line x1="3" y1="18" x2="21" y2="18"/><circle cx="16" cy="18" r="2" fill="currentColor" stroke="none"/>' },
        'history': { body: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="12" x2="12" y2="7"/><line x1="12" y1="12" x2="15.5" y2="15"/><path d="M3.5 11A8.5 8.5 0 0 1 11.5 3.5"/>' },
        'bars': { body: '<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="6.75" y1="8.5" x2="17.25" y2="8.5"/><line x1="6.75" y1="12" x2="17.25" y2="12"/><line x1="6.75" y1="15.5" x2="17.25" y2="15.5"/>' },
        'wifi': { body: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>' },
        'bell': { body: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>' },
        'bell-slash': { body: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><line x1="2" y1="3" x2="22" y2="21"/>' },
        'moon': { body: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>' },
        'sun': { body: '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/>' },
        'eye': { body: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>' },
        'eye-slash': { body: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>' },
        'target': { body: '<circle cx="12" cy="12" r="9"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>' },
        'sign-out-alt': { body: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>' },
        'sort': { body: '<polyline points="8 9 12 5 16 9"/><polyline points="8 15 12 19 16 15"/>' },
        'paper-plane': { body: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>' },
        'key': { body: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>' },
        'save': { body: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>' },
        'copy': { body: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' },
        'code': { body: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>' },
        'upload': { body: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>' },
        'download': { body: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>' },
        'trash': { body: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>' },
        'clock': { body: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="7" x2="12" y2="12"/><line x1="12" y1="12" x2="15.5" y2="14.5"/>' },
        'spinner': { body: '<path d="M22 12h-4l-3-8-4 16-3-8H2"/>', loading: '<line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>' },
        'check-circle': { body: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>' },
        'check': { body: '<polyline points="20 6 9 17 4 12"/>' },
        'exclamation-triangle': { body: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' },
        'hourglass-end': { body: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22"/><path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"/>' },
        'inbox': { body: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>' },
        'folder-open': { body: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>' },
        'search': { body: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>' },
        'chevron-left': { body: '<polyline points="15 18 9 12 15 6"/>' },
        'chevron-right': { body: '<polyline points="9 18 15 12 9 6"/>' },
        'chevron-up': { body: '<polyline points="18 15 12 9 6 15"/>' },
        'chevron-down': { body: '<polyline points="6 9 12 15 18 9"/>' },
        'paperclip': { body: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.49"/>' },
        'sync-alt': { body: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>' },
        'cog': { body: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>' },
        'undo': { body: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>' },
        'user-slash': { body: '<circle cx="9.5" cy="8" r="4"/><path d="M2.5 20c0-3.2 3-5 7-5"/><line x1="22" y1="22" x2="4" y2="2"/>' },
        'ban': { body: '<circle cx="12" cy="12" r="9"/><line x1="5.64" y1="5.64" x2="18.36" y2="18.36"/>' },
        'shield-alt': { body: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' }
    };

    function render(name, options) {
        options = options || {};
        const def = ICONS[name];
        if (!def) {
            console.error('Icons.render: unknown icon "' + name + '"');
            return '';
        }
        let body = def.body;
        let cls = 'icon-svg';
        if (options.state === 'loading') {
            body = def.loading || def.body;
            cls += ' icon-spin';
        }
        if (options.className) cls += ' ' + options.className;

        const styles = ['vertical-align:-0.125em;'];
        if (options.style) styles.push(options.style.replace(/;\s*$/, '') + ';');

        let svg = '<svg class="' + cls + '" width="1em" height="1em" viewBox="0 0 24 24" ' + ATTRS + ' style="' + styles.join('') + '"';
        if (options.label) {
            svg += ' role="img"><title>' + options.label + '</title>' + body + '</svg>';
        } else {
            svg += ' aria-hidden="true">' + body + '</svg>';
        }
        return svg;
    }

    function hydrate(root) {
        root = root || document;
        const nodes = root.querySelectorAll('[data-icon]');
        for (let i = 0; i < nodes.length; i++) {
            const el = nodes[i];
            const name = el.getAttribute('data-icon');
            if (!name || el.querySelector('svg')) continue;
            el.innerHTML = render(name, { label: el.getAttribute('aria-label') });
        }
    }

    document.addEventListener('DOMContentLoaded', hydrate);

    window.Icons = { render: render, hydrate: hydrate };
})();
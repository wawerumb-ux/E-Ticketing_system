/**
 * tubes-bg.js — Offline WebGL tubes background for login.html
 *
 * Wraps tubes1.min.js (threejs-components, self-bundled with Three.js r180).
 * Called only when navigator.onLine is false (Option C: wallpaper online,
 * tubes offline). Loaded as a plain <script type="module"> in login.html.
 *
 * API exposed on window.__tubesBg:
 *   init(canvas)   — start the animation
 *   dispose()      — stop and clean up (e.g. if the user comes back online)
 *
 * Offline rules satisfied:
 *   O1 — no remote imports; tubes1.min.js is vendored at /vendor/tubes1.min.js
 *   O2 — renders identically offline; no layout shift
 *   LAY2 — z-index -1 (below auth-shell at z-index 1)
 */

/* Palette — dark, neon-accented to match --auth-ink (#14151B) background */
const TUBE_COLORS  = ['#f967fb', '#53bc28', '#6958d5'];
const LIGHT_COLORS = ['#83f36e', '#fe8a2e', '#ff008a', '#60aed5'];

function randomHex() {
    return '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
}

function randomPalette(count) {
    return Array.from({ length: count }, randomHex);
}

let _app    = null;   // tubes1 instance
let _canvas = null;   // the <canvas> element
let _clickHandler = null;

async function init(canvas) {
    if (_app) return;   // already running
    _canvas = canvas;

    let TubesCursor;
    try {
        // Local vendor file — no CDN, fully offline-safe (O1).
        const mod = await import('/vendor/tubes1.min.js');
        TubesCursor = mod.default;
    } catch (err) {
        // tubes1 failed to load (e.g. SW not yet populated on very first visit).
        // Silently bail — the brand panel behind the canvas is still visible.
        console.warn('[tubes-bg] Could not load tubes1.min.js:', err);
        return;
    }

    try {
        _app = TubesCursor(canvas, {
            bloom: { threshold: 0, strength: 1.5, radius: 0.5 },
            tubes: {
                colors: TUBE_COLORS,
                lights: {
                    intensity: 200,
                    colors: LIGHT_COLORS
                }
            },
            /* Sleep orbit so tubes keep moving when the cursor is outside
               the canvas (matches reference behaviour). */
            sleepRadiusX:    300,
            sleepRadiusY:    150,
            sleepTimeScale1: 1,
            sleepTimeScale2: 2
        });
    } catch (err) {
        console.warn('[tubes-bg] TubesCursor init failed:', err);
        return;
    }

    /* Click anywhere on the canvas to randomise colours. */
    _clickHandler = function () {
        if (!_app) return;
        _app.tubes.setColors(randomPalette(3));
        _app.tubes.setLightsColors(randomPalette(4));
    };
    canvas.addEventListener('click', _clickHandler);
}

function dispose() {
    if (_clickHandler && _canvas) {
        _canvas.removeEventListener('click', _clickHandler);
        _clickHandler = null;
    }
    if (_app) {
        try { _app.dispose(); } catch (_) { /* ignore */ }
        _app = null;
    }
    _canvas = null;
}

/* Expose on window so login.html inline script can call init/dispose
   without needing its own module context. */
window.__tubesBg = { init, dispose };

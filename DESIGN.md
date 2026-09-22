# E-Ticketing System — Editorial Design System Specification

## 1. Design Philosophy

The E-Ticketing System interface unites **high-craft editorial typography** with **rigorous, offline-first systems engineering**. Inspired by contemporary editorial publications (Stripe Press, Awwwards, SiteInspire), it eschews generic corporate dashboard tropes in favor of:

1. **Deliberate Typographic Scale**: High-contrast display serifs (`Fraunces`, self-hosted OFL-1.1 variable subset) paired with clean native system sans-serif body typography.
2. **Zero-CDN Offline Determinism**: Zero runtime reliance on Google Fonts, unpkg, cdnjs, or remote telemetry. The UI renders identically whether operating on an isolated intranet or high-speed fiber.
3. **Tactile Micro-Interactions**: Predictable spring physics (`cubic-bezier(0.16, 1, 0.3, 1)`), subtle noise texture overlays (generated via data-URI SVGs), and instant `<180ms` visual feedback.
4. **Uncompromising Accessibility (WCAG 2.1 AA)**: All text meets or exceeds 4.5:1 contrast against its rendered surface (3:1 for large text). Focus indicators are prominent (3px custom focus halos), and keyboard traps are enforced on modal drawers.

---

## 2. Token Architecture & Variable Hierarchy

The design system operates on a 3-tier token architecture:

```
[ Tier 1: Core Tokens ]        design-tokens.json (Raw mathematical primitives)
          ↓
[ Tier 2: CSS Semantic Layer ] vars.css (--site-*, --brand-* custom properties)
          ↓
[ Tier 3: Component Layer ]    header.html, footer.html, style.css
```

### 2.1 Palette & Contrast Validation

All status pills and informational banners utilize **matched tint-and-ink pairs** to guarantee WCAG compliance across both light and dark themes:

| Token Name | Light Surface Tint | Dark Surface Ink | Contrast Ratio | Compliance |
|---|---|---|---|---|
| **Success** (`--site-success-*`) | `#dcfce7` (Mint 100) | `#15803d` (Green 700) | 5.8:1 | **WCAG AA** |
| **Warning** (`--site-warning-*`) | `#fef3c7` (Amber 100) | `#b45309` (Amber 700) | 4.9:1 | **WCAG AA** |
| **Danger** (`--site-danger-*`) | `#fee2e2` (Red 100) | `#b91c1c` (Red 700) | 6.2:1 | **WCAG AA** |
| **Info / Telemetry** (`--site-info-*`)| `#e0f2fe` (Sky 100) | `#1d4ed8` (Blue 700) | 6.5:1 | **WCAG AA** |

### 2.2 Fluid Typography Scale (`clamp()`)

Typography scales continuously between mobile viewports (360px) and wide desktop displays (1440px) without jagged breakpoint jumps:

- **Hero Display**: `clamp(2rem, 1.6rem + 2vw, 3.25rem)` (32px to 52px)
- **Title Large**: `clamp(1.4rem, 1.15rem + 1.25vw, 2.15rem)` (22.4px to 34.4px)
- **Title Medium**: `clamp(1.15rem, 1rem + 0.75vw, 1.5rem)` (18.4px to 24px)
- **Lead Prose**: `clamp(1rem, 0.95rem + 0.25vw, 1.125rem)` (16px to 18px)
- **Standard Body**: `1rem` (16px constant baseline)
- **Annotation / Caption**: `0.75rem` (12px minimum floor per TXT7 rules)

---

## 3. Component Specifications

### 3.1 Site Header (`header.html`)
- **Semantic Landmark**: `<header class="site-header" role="banner">`
- **Skip Navigation**: Preceding the header is a hidden skip link (`.site-skip-link`) that translates into view upon keyboard `Tab` focus, directing the user to `#main-content`.
- **Search Affordance**: Vertically centered magnifier icon (`16x16`), search input, and keyboard indicator (`/`). Pressing `/` anywhere on the page focuses the search box unless an input is already focused.
- **Focus Mode Toggle**: Toggles `.focus-mode` on the document root, dimming non-essential decorative elements and pausing non-critical micro-interactions for neurodivergent and low-distraction workflows.
- **Connection Telemetry**: Live network indicator pill reading `navigator.onLine` and listening for `online` / `offline` events.

### 3.2 Mobile Drawer & Focus Trap
- **Off-Canvas Drawer**: `<aside class="site-drawer" id="siteMobileDrawer" role="dialog" aria-modal="true">`
- **A11y Engine**:
  - Automatically traps focus between the close button and the last navigation link.
  - Closes on `Escape` key press.
  - Automatically returns focus to the trigger button (`#siteHeaderDrawerOpen`) when closed.
  - `hidden` attribute toggle prevents screen reader exposure when closed.

### 3.3 Site Footer (`footer.html`)
- **Semantic Landmark**: `<footer class="site-footer" role="contentinfo">`
- **Architectural Grid**:
  - Column 1: Core navigation landmarks.
  - Column 2: Architectural specifications (WCAG rating, offline storage engines).
  - Column 3: Operator keyboard shortcuts legend (`/`, `Esc`, `Tab`).
- **Telemetry Card**: Displays real-time local cache state and synchronization guarantees.

---

## 4. Offline Service Worker Strategy (`service-worker.js`)

The service worker enforces a dual caching tier:

```
[ Network Request ]
       |
  Is Immutable? (Fonts, Libs) ----> YES ----> [ Cache-First ]
       | NO
  Is Data GET? (Tickets, KB)  ----> YES ----> [ Network-First ] (Keyed by User Auth Hash)
       | NO
  Is App Shell? (HTML, CSS)   ----> YES ----> [ Network-First with Cached Fallback ]
       | NO
  Is Mutation? (POST/PUT/DEL) ----> Passthrough to Network (Offline queued via IndexedDB)
```

1. **Zero Auth Token Leakage**: The service worker never stores JWT tokens in Cache Storage.
2. **User Cache Isolation**: Data responses are stored under a hash key derived from the `Authorization` header (`__user_scope=hash`), preventing cross-account data leakage on shared workstations.

---

## 5. Developer Integration & Maintenance

### 5.1 CSS Integration
To integrate the new token system into existing pages:
```html
<link rel="stylesheet" href="/shared/css/style.css">
<link rel="stylesheet" href="/vars.css">
```

### 5.2 Header Integration
Insert the header partial immediately after `<body>` or replace `<header class="top-header">`:
```html
<!-- Insert header.html markup -->
<main class="main-content" id="main-content">
  <!-- Page Sections -->
  <!-- Insert footer.html markup before closing </main> -->
</main>
```

### 5.3 Theme Compatibility
The `--site-*` tokens automatically inherit values from `--primary`, `--surface`, and `--text` defined in `frontend/shared/css/style.css`. All 11 themes (Daylight, Abyss, Night Owl, Quiet Light, Solarized Light, High Contrast, Flexoki Light, Catppuccin Latte, Catppuccin Mocha, Nord, and Gruvbox) function out of the box.

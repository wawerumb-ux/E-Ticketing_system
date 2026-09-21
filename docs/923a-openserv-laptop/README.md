# 923a · OpenServ Laptop Scroll Landing — Blueprint

> Nexus ICT | Production-Ready Landing Page — re-skinned to the OpenServ
> design system ("Bright blueprint on frosted glass") as a scroll-driven
> **assemble / disassemble laptop** landing concept, produced for
> commit into this codebase as a **showcase template**.

- Source draft (Superdesign): `c8973644-f469-47da-ac71-7602ff76f98c`
  (project `923a0c55-989d-48a6-bda2-4c1e928da74b`, "Motion Scroll Creative")
- Reference draft: `4603e195-f882-47b6-8d5d-22064eefa7be` (MacBook deconstruction)
- Style system: OpenServ — tokens distilled from the official Quick Start
  (`styles.refero.design/style/063be10d-...`), reproduced verbatim in
  `tokens.css`.

---

## 1. Quick summary

**Purpose:** transform the Nexus ICT "explode-view laptop" scroll metaphor into
an OpenServ-branded landing that *assembles* a laptop as you scroll — each
layer is a named e-ticketing capability (Display → Input → Logic → Power →
Chassis), and the motion is the story ("we see every component of your ICT
landscape").

**Primary UX idea:** a sticky full-viewport laptop-stage section; scroll
progress drives a per-layer timeline that first *disassembles* (revealing
labelled capability cards), then *snaps back together* into a floating,
finished laptop with one violet-pill CTA. Reduced-motion and mobile get a
stacked crossfade — same content, zero 3D.

**Tech choices:** **Vanilla HTML/CSS + CSS Scroll-Linked Animations / Web
Animations API** — no build step, no dependencies, offline-safe, matches the
repo's "no frameworks, no build" rule. GSAP ScrollTrigger is documented as the
progressive-enhancement alternative but is **not** part of the committed
implementation (package_install is forbidden here).

---

## 2. UX storyboard — scroll frames

The whole animation lives inside one **sticky stage** (`min-height: 400vh`,
`position: sticky; top: 0; height: 100vh`). The stage section is the only
standalone section that spans multiple viewport heights — but we align each
stage to the **OpenServ 1200px / 80px-gap rhythm** by making the rest of the
page flow normally around it.

| Scroll | Progress | What is visible | Stage state |
|---|---|---|---|
| `0%` | 0.00 | Hero editorial block: OS Chronik 300 display, floating nav, violet pill CTA "Open App ↗". Laptop sits assembled, tiny, at 60% opacity as a "preview" below the fold line. | Assembled (start pose) |
| `8%` | Enter stage | Sticky stage locks; hero scrolls away. Grid lines fade in (`#a6a6a6` hairline, 40px grid). | Assembled, centered |
| `14%` | 0.10 | Screen separates upward, hinge gap appears; label "Display Node" card slides in from right. | Disassembly starts |
| `30%` | 0.45 | All five layers flying: screen ↑, keyboard ↓↘, logic ↓ (slight rotateX), battery ↓, chassis ↓ larger — each with its labelled capability card. Sparkle field visible. | Fully disassembled |
| `45%` | 1.00 | Max spread. "We deconstruct your entire ICT landscape" editorial line in OS Chronik 300 centered **behind** the parts. | Disassembled apex |
| `55%` | 1.0 → 0 | Assembly begins: layers reverse toward center, hinge re-locks, screen rotates back in. | Reassembling |
| `80%` | 0.15 | Laptop back to assembled pose, now full opacity, mint status dot "All nodes active" + CTA "Open Ticket ↗". | Assembled (end pose) |
| `100%` | — | Stage releases; laptop fades; page delivers into the card grid + tri-color section stripe. | Released |

**Reduced-motion fallback:** `@media (prefers-reduced-motion: reduce)` — no
sticky stage, no 400vh; laptop renders as one flat illustration (all layers
merged at final pose), labels as a static 2×2 definition grid beside it. Pure
crossfade of the three "moments" (hero → stage → grid), no translation.

**Mobile fallback (≤768px):** same as reduced-motion but with the laptop shown
at 2× raster; labels collapse to a stacked list under the illustration;
sticky stage height shrinks to `min-height: 100vh` with a single crossfade
instead of drivable parts. No 3D transforms on mobile.

---

## 3. Visual spec (exact OpenServ tokens)

### 3.1 Color + typography + spacing

All value IDs below mirror the OpenServ Quick Start. The committed
`tokens.css` is the authoritative source. Fonts are **not available locally**:
see 3.4 for the self-hosted substitution.

| Slots used | Token | Value |
|---|---|---|
| Canvas | `--color-pure-white` | `#ffffff` |
| Card lift | `--color-fog-gray` | `#f5f5f5` |
| Tint wash | `--surface-tint-wash` | `#d9defc` |
| Ink (h1/body) | `--color-ink-black` | `#000000` |
| Body secondary | `--color-ash-gray` | `#4d4d4d` |
| Muted / helper | `--color-slate-gray` | `#707070` |
| Muted nav / borders | `--color-mist-gray` | `#a6a6a6`/`#f5f5f5` |
| Tertiary border | `--color-smoke-gray` | `#9c9c9c` |
| **Primary action** | `--color-signal-violet` | `#5f79ff` |
| **Status only** | `--color-mint-pulse` | `#01fe93` |
| Display UI | `--font-os-studio-grotesk` | OS Studio Grotesk 400 |
| Display editorial | `--font-os-chronik` | OS Chronik 300 |
| Display type | `--text-display` | 72px / lh 0.9 / `-1.44px` |
| Section gap | `--section-gap` | 80px |
| Card radius | `--radius-cards` / `--radius-2xl` | 16px |
| Nav radius | `--radius-nav` | 16px |
| Input radius | `--radius-inputs` | 12px |
| Button/badge radius | `--radius-buttons` / `--radius-badges` | 100px |
| Shadow (nav only) | `--shadow-xl` | `rgba(0,0,0,.1) 0 0 48px` |
| Page width | `--page-max-width` | 1200px |
| Card padding | `--card-padding` | 24px |

**Do's/Don'ts honored:** violet pill for every primary action; mint only as
status (status dot, not a button); no card shadows; hairline borders
`#a6a6a6`/`#f5f5f5`; negative tracking `-0.020em` @72px, `-0.017em` @20–24px;
16px on all cards/images/nav; 100px only on pills/badges; tri-color section
stripe (`#01fe93` → `#5f79ff` → `#000`) only as the closing band.

### 3.2 Components

| Component | Size | Radius | Padding | Tokens | Imagery |
|---|---|---|---|---|---|
| Floating nav | 1200px max, floats 24px top | 16px | 12–18px inner | `--color-pure-white`, `--shadow-xl`, `--radius-nav` | concentric-ring logo lockup (inline SVG), ghost links |
| Hero editorial | 1200px, 80px gap | — | — | `--text-display`, OS Chronik 300, `-1.44px` | sparkles (`#d9defc` 15%) only |
| Laptop stage | 600×400 core, sticky 100vh | 16px (parts) | — | ink on white, hairline grid `#a6a6a6` 40px | SVG layers only (see §3.3) |
| Card grid | 3-col → 1-col ≤768px | 16px | 24px | `--color-pure-white`, 1px `#f5f5f5`, title Grotesk 20px | highlight card w/ 16px-radius image block |
| Highlight card | 40–50% image, rest body | 16px | 24px | violet caption 12px, title 24px, body 15px `#4d4d4d` | soft network-graph illustration (SVG) |
| Section stripe | 3px full-bleed | — | — | mint `#01fe93` / violet `#5f79ff` / black `#000` | closing band only |

### 3.3 Asset format & naming

Laptop parts as **separate optimized SVG layers**, one file per part, matching
stable IDs so CSS/WAAPI selectors are deterministic:

```
laptop-parts/
  screen.svg      #screen      viewBox 0 0 600 400, ink strokes on white, 16px radius
  keyboard.svg    #keyboard
  hinge.svg       #hinge
  logic.svg       #logic       (motherboard metaphor — circuit lines, violet/mint strokes)
  battery.svg     #battery
  chassis.svg     #chassis
  assembled.svg   #assembled   (all parts merged at final pose — static/reduced-motion)
  sparkles.svg    (decor four-point stars, #d9defc)
```

SVG export rules (SVGO params in `assets/optimizer-config.json`): `cleanupIds: false`
(preserve `#screen` etc.), `removeViewBox: false`, `minifyStyles: true`,
`collapseGroups: false`, `convertPathData: true`, `precision: 1`, no embedded
raster, path-level transforms only, `shape-rendering="geometricPrecision"` on
the logo/circuit art. Raster fallbacks: `assembled@2x.png`/`.webp` (400p,
`preserve-3d`-unsupported browsers) — **to be exported** when the figure is
finalized.

### 3.4 Font strategy (offline-safe substitutions)

| OpenServ role | Name | Substitute (self-hosted) |
|---|---|---|
| UI 400 | OS Studio Grotesk | `--font-os-studio-grotesk: 'Inter', system-ui, ...` — self-host `Inter` woff2 in `openserv-assets/` (or use `--font-sans-serif` system chain) |
| Display 300 | OS Chronik | `--font-os-chronik: 'Fraunces', Georgia, serif` — **already self-hosted** at `/shared/fonts/fraunces-latin.woff2` (weight 300–700 variable); Fraunces 300 reads as the whisper-light serif pair. Fallback `Georgia`. |

Zero network. Both stacks degrade to system serif/sans identically offline.

---

## 4. Motion spec (pixel/animation-level)

### 4.1 Per-part timeline (disassembly is the forward play; assembly = reverse)

Poses defined in CSS custom props so WAAPI and ScrollTimeline read the same
values. Base pose = assembled at `translate(0) rotateX(0)`.

| Part | Initial (assembled) | Final (disassembled) | origin | dur | ease | stagger | z | opacity |
|---|---|---|---|---|---|---|---|---|
| `#screen` | `0 0 0` | `translateY(-190px) rotateX(24deg)` | `50% 100%` | 700ms | `cubic-bezier(.22,.9,.3,1)` | `.08s` | 50 | 1→0.96 |
| `#keyboard` | `0 0 0` | `translateY(-60px) rotateX(10deg)` | `50% 100%` | 700ms | same | `.12s` | 40 | 1→0.92 |
| `#logic` | `0 0 0` | `translateY(90px) rotateX(-6deg)` | `50% 0%` | 750ms | same | `.16s` | 30 | 1→0.88 |
| `#battery` | `0 0 0` | `translateY(200px)` | `50% 0%` | 750ms | same | `.20s` | 20 | 1→0.80 |
| `#chassis` | `0 0 0` | `translateY(330px) scale(1.12)` | `50% 0%` | 800ms | same | `.24s` | 10 | 1→0.75 |
| `#hinge` | `0 0 0` | `translateX(150px) rotateZ(8deg)` | `50% 50%` | 650ms | `.3,.0,.4,1` | `.10s` | 60 | 1→0.9 |

Only `transform` + `opacity` animate (GPU-composited). `will-change: transform, opacity`
on `.laptop-part`). No layout-triggering properties.

### 4.2 Scroll mapping

`scrollProgress` (0→1 across the stage) drives a **two-phase timeline**:
forward `0→1` goes 0–45% of the section, `1→0` (assembly) goes 55–80%.
Sticky stage makes `rect.height − innerHeight` the total travel.

```css
/* CSS scroll-scoped — prefers no JS */
@supports (animation-timeline: view()) {
  .laptop-part {
    animation: part-play linear both;
    animation-timeline: view();
    animation-range: entry 8% exit 72%;   /* phase split per part via --part */
  }
}
```

WAAPI fallback (committed reference, `scroll-assembly.js`): one `rAF`
handler reads `progress`, passes it to a small easer, writes `translate3d`
per part from the same pose table. ~60 lines, no deps.

### 4.3 Performance

Transform+opacity only; parts promoted via `will-change`; stage uses
`position: sticky` (native, no JS scroll hijack); non-critical assets
lazy-loaded after hero (`loading="lazy"` on raster fallback; SVGs are inline).
Target: ≥90 Lighthouse desktop.

---

## 5. Implementation plan into codebase

### 5.1 Stack

**Chosen:** Vanilla HTML/CSS + CSS ScrollTimeline (`view()`) + WAAPI fallback.
Files are static; served unchanged by the existing Flask `/showcase` loader and
`serve_static`. No build step, no npm, no vendored JS beyond one ~60-line
module. **Alternate (documented only):** GSAP ScrollTrigger — see
`gsap-skeleton.js` reference; would require vendoring GSAP (package_install is
forbidden in this repo, so it is deliberately not committed).

### 5.2 File / component map

```
frontend/showcase/templates/openserv-laptop.html      # template w/ <!--SHOWCASE_CONFIG--> marker
frontend/showcase/templates/openserv-assets/
  laptop/screen.svg  keyboard.svg  hinge.svg  logic.svg  battery.svg  chassis.svg  assembled.svg
  sparkles.svg
  fonts/inter.woff2 (to be provided)         # or rely on system --font-sans-serif
  icons/rings.svg, arrow.svg, plus.svg, dot.svg
  raster/assembled@2x.webp (to be exported)  # reduced-motion fallback
backend/routes/showcase.py   # add 'openserv-laptop' to SHOWCASE_TEMPLATES (smallest change)
scripts/validate-frontend.js # already pairs templates with shared auth-shim — re-run
```

Planned component structure (single HTML section, no framework):

- `<header class="nav">` — OpenServ floating nav
- `<section id="hero">` — hero editorial block
- `<section id="stage">` — sticky laptop stage (the 400vh tall section)
- `<section id="grid">` — card grid + highlight card
- `<footer>` — tri-color section stripe + footer

### 5.3 Code-first snippets

**tokens.css** — see `samples/tokens.css`; committed verbatim from OpenServ
Quick Start.

**Vanilla scroll-assembly (WAAPI fallback, committed):**

```js
import { LAPTOP_PARTS, lerp, easeInOut } from './pose-table.js';
const stage = document.querySelector('#stage');
let progress = 0;
function update() {
  const r = stage.getBoundingClientRect();
  const total = r.height - window.innerHeight;
  progress = Math.min(1, Math.max(0, -r.top / total));
  for (const part of LAPTOP_PARTS) {
    const p = part.ease(progress);
    part.el.style.transform =
      `translate3d(${lerp(0, part.x, p)}px, ${lerp(0, part.y, p)}px, 0)` +
      (part.rz ? ` rotate(${part.rz * p}deg)` : '');
    part.el.style.opacity = 1 - part.fade * p;
  }
}
addEventListener('scroll', () => requestAnimationFrame(update), { passive: true });
```

**GSAP ScrollTrigger (reference only, not committed):**

```js
gsap.registerPlugin(ScrollTrigger);
gsap.to('#screen',  { y: -190, rotateX: 24, ease: 'power3.out', duration: 0.7 });
gsap.to('#chassis', { y: 330, scale: 1.12, ease: 'power3.out', duration: 0.8 });
ScrollTrigger.create({ trigger: '#stage', start: 'top top', end: 'bottom bottom',
  onUpdate: (t) => { const p = t.progress; } });
```

**Reduced-motion fallback (committed):**

```css
@media (prefers-reduced-motion: reduce) {
  #stage { min-height: 100vh; position: relative; }       /* no 400vh prison */
  .laptop-part { animation: none; transform: none !important; }
  #stage .laptop { background: url('assets/raster/assembled@2x.webp') center/contain no-repeat; }
}
```

### 5.4 Build & bundling

No bundler. The scroll module is loaded only when the stage is reachable
(`<script type="module" src="...openserv-assets/scroll-assembly.js" defer>`)
so it never blocks the hero render; everything else is inline + atomic CSS
(critical above-the-fold styles inline in `<head>`, remainder in one stylesheet).

---

## 6. Deliverables & acceptance criteria

| Deliverable | State |
|---|---|
| Figma frames (all breakpoints + annotated motion frames) | to be produced |
| Export-ready SVG parts (`#screen … #assembled`) | **to be exported** (naming fixed in §3.3) |
| Web prototype (Framer/CodeSandbox) | to be produced |
| Production code (template + tokens + animation) | committed when built |
| Motion spec doc | §4 + this doc |

**PR checklist:** visual review vs tokens; reduced-motion test; Lighthouse
desktop ≥ 90; cross-browser (Chrome/FF/Safari + `@supports` split); mobile
stacked fallback; `getElementById`↔`id` cross-ref passes `validate-frontend.js`;
no remote URLs; WCAG AA contrast on every text surface; keyboard-focus visible
on flip/CTA/labels.

**Integration checklist:** branch already created (`feature/923a-laptop-scroll`);
commit messages `<verb> openserv landing: <what>`; update `docs/923a-openserv-laptop/README.md`
on changes; PR links to Superdesign project `923a0c55`.
When the template ships, add `'openserv-laptop'` to `SHOWCASE_TEMPLATES`
(`backend/routes/showcase.py`) in the **same** commit that adds the HTML.

---

## 7. Time estimate & milestones

| Milestone | Effort |
|---|---|
| Discovery & spec | 1.5d (done — this doc) |
| Design comps + Figma frames | 2d |
| Asset production (SVG parts + raster fallback) | 0.5d |
| Prototype (interactive) | 1d |
| Engineering: template + components + tokens | 2d |
| Animations + performance polish | 2d |
| QA + PR | 1d |
| **Total** | **~10 days** |

**MVP (3–4 days):** assembled laptop + single scroll-driven *assembly* sweep
+ violet pill CTA + reduced-motion fallback. Labels/cards/stripe deferred.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Scroll jank on low-end | sticky-native (no JS hijack), transform/opacity only, rAF-throttled WAAPI, reduced-motion & static snapshot |
| SVG repaint cost | minimal path groups, fewer nodes, path-level transforms precomputed, raster fallback for legacy |
| OS Chronik/Grotesk flash or missing | preload self-hosted woff2, existing `/shared/fonts/fraunces-latin.woff2` covers display; system chain covers UI; no FOUT since font-display: swap |
| Tailwind/CDN drift from the draft | none — this port is framework-free, token-pure |

---

## 9. Next actions

1. ✅ Fetched draft `c8973644` + reference `4603e195` (Superdesign CLI, one-time network grant).
2. ✅ Branch `feature/923a-laptop-scroll` created (this blueprint commits here).
3. ⏳ Produce Figma frames + prototype (design phase).
4. ⏳ Export SVG parts into `openserv-assets/laptop/` per §3.3 naming.
5. ⏳ Commit `tokens.css` (already here as `samples/tokens.css`) + template + animation.
6. ⏳ Open draft PR with checklist; link to project `923a0c55`.

---

## 10. Sample code snippets

See the committed files in `samples/`:
- `tokens.css` — OpenServ `:root` variables (verbatim Quick Start)
- `scroll-assembly.js` — WAAPI scroll-linked assembly (~60 lines, dependency-free)
- `gsap-skeleton.js` — GSAP ScrollTrigger reference (not committed to the app)
- `reduced-motion.css` — `prefers-reduced-motion` crossfade → static assembled image

SVG naming convention (see §3.3): one file per part with a stable top-level id —
`#screen`, `#keyboard`, `#hinge`, `#logic`, `#battery`, `#chassis`, `#assembled`.
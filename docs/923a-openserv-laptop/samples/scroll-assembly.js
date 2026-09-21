/**
 * scroll-assembly.js — OpenServ laptop stage, WAAPI fallback.
 * Dependency-free. Drives the assemble/disassemble timeline off scroll
 * progress across the sticky #stage container, writing only transform +
 * opacity (GPU-composited properties).
 *
 * Selection contract: each part is a `[data-part]` element (e.g.
 * data-part="screen") inside #stage .laptop. Poses mirror the CSS custom
 * props in section 4.2 of the blueprint.
 */

(() => {
  'use strict';

  const stage = document.querySelector('#stage');
  if (!stage) return;

  /** Part pose table. y: px of translateY at full disassembly,
   *  rz: deg of rotateZ, ox: origin x (0-1), oy: origin y (0-1),
   *  fade: max opacity drop. */
  const PARTS = {
    screen:   { y: -190, ox: 0.5, oy: 1.0, fade: 0.04 },
    keyboard: { y: -60,  ox: 0.5, oy: 1.0, fade: 0.08 },
    logic:    { y: 90,   ox: 0.5, oy: 0.0, fade: 0.12 },
    battery:  { y: 200,  ox: 0.5, oy: 0.0, fade: 0.20 },
    chassis:  { y: 330,  ox: 0.5, oy: 0.0, fade: 0.25 },
    hinge:    { y: 0,    x: 150,  rz: 8,   ox: 0.5, oy: 0.5, fade: 0.10 },
  };

  const parts = Object.fromEntries(
    Object.keys(PARTS).map((name) => [
      name,
      document.querySelector(`[data-part="${name}"]`),
    ]),
  );

  if (Object.values(parts).some((el) => !el)) return;

  /** Two-phase easing: disassemble on 0->45%, reassemble on 55%->80%. */
  const phase = (p) => {
    if (p < 0.45) return p / 0.45;            /* forward  */
    if (p < 0.55) return 1;                   /* apex     */
    if (p > 0.8) return 0;                    /* released */
    return 1 - (p - 0.55) / 0.25;             /* reverse  */
  };

  const lerp = (a, b, t) => a + (b - a) * t;

  let ticking = false;
  const update = () => {
    ticking = false;
    const rect = stage.getBoundingClientRect();
    const travel = rect.height - window.innerHeight;
    const raw = travel > 0 ? -rect.top / travel : 0;
    const p = Math.min(1, Math.max(0, raw));
    const k = phase(p);

    for (const [name, el] of Object.entries(parts)) {
      const pose = PARTS[name];
      const x = lerp(0, pose.x || 0, k);
      const y = lerp(0, pose.y || 0, k);
      const rz = lerp(0, pose.rz || 0, k);
      el.style.transformOrigin = `${pose.ox * 100}% ${pose.oy * 100}%`;
      el.style.transform =
        `translate3d(${x}px, ${y}px, 0) rotate(${rz}deg)`;
      el.style.opacity = String(1 - (pose.fade || 0) * k);
    }
  };

  addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  update();
})();
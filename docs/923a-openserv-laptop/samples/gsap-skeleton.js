/**
 * gsap-skeleton.js — GSAP ScrollTrigger REFERENCE ONLY.
 *
 * NOT committed to the app: package_install is forbidden on this repo and
 * the committed implementation is vanilla (scroll-assembly.js +
 * CSS ScrollTimeline). This file documents the alternate production setup
 * so a team with a build/vendoring path can switch.
 *
 * Peer-reviewed GSAP ScrollTrigger mapping of the same pose table:
 */

// import { gsap } from 'gsap';
// import { ScrollTrigger } from 'gsap/ScrollTrigger';
// gsap.registerPlugin(ScrollTrigger);

// const tl = gsap.timeline({
//   scrollTrigger: {
//     trigger: '#stage',
//     start: 'top top',
//     end: 'bottom bottom',
//     scrub: 1,
//   },
// });

// // phase 1: forward disassembly (0 -> apex at 45% of travel)
// tl.to('#screen',   { y: -190, rotateX: 24,  ease: 'power3.out', duration: 0.5 }, 0)
//   .to('#keyboard', { y: -60,  rotateX: 10,  ease: 'power3.out', duration: 0.5 }, 0)
//   .to('#logic',    { y: 90,   rotateX: -6,  ease: 'power3.out', duration: 0.5 }, 0)
//   .to('#battery',  { y: 200,                ease: 'power3.out', duration: 0.5 }, 0)
//   .to('#chassis',  { y: 330,  scale: 1.12,  ease: 'power3.out', duration: 0.5 }, 0)
//   .to('#hinge',    { x: 150,  rotate: 8,    ease: 'power3.out', duration: 0.5 }, 0);

// // phase 2: reverse assembly (55% -> 80%) — mirror with immediateRender:false;
// tl.to(Object.keys(PARTS).map((n) => '#' + n), {
//   y: 0, x: 0, rotateX: 0, rotate: 0, scale: 1, opacity: 1,
//   ease: 'power2.in', duration: 0.5,
// }, 0.55);

// // static final pose for reduced-motion consumers
// const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
// if (mq.matches) tl.progress(0) && tl.pause();
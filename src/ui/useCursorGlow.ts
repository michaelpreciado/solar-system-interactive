import { useEffect } from 'react';

/**
 * Writes pointer position into CSS variables, at most once per frame, with no
 * React renders: --cx/--cy (percent of viewport) and --px/--py (-1..1) on the
 * root for the ambient glow and corner parallax, and --mx/--my (px, relative to
 * the hovered glass surface) for the panel sheen. Skipped on touch and under
 * reduced motion.
 */
export function useCursorGlow(root: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const el = root.current;
    if (!el || typeof matchMedia === 'undefined') return;
    if (
      matchMedia('(pointer: coarse)').matches ||
      matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;

    let raf = 0;
    let e: PointerEvent | null = null;
    const apply = () => {
      raf = 0;
      if (!e) return;
      const w = window.innerWidth;
      const h = window.innerHeight;
      el.style.setProperty('--cx', ((e.clientX / w) * 100).toFixed(1));
      el.style.setProperty('--cy', ((e.clientY / h) * 100).toFixed(1));
      el.style.setProperty('--px', ((e.clientX / w) * 2 - 1).toFixed(3));
      el.style.setProperty('--py', ((e.clientY / h) * 2 - 1).toFixed(3));
      const surface = (e.target as Element | null)?.closest?.<HTMLElement>(
        '.body-rail, .inspector, .timeline, .panel'
      );
      if (surface) {
        const r = surface.getBoundingClientRect();
        surface.style.setProperty('--mx', `${e.clientX - r.left}px`);
        surface.style.setProperty('--my', `${e.clientY - r.top}px`);
      }
    };
    const onMove = (ev: PointerEvent) => {
      e = ev;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, [root]);
}

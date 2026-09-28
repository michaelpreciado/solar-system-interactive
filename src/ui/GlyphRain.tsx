import { useEffect, useRef } from 'react';

const GLYPHS = '01アイウエオカキクケコサシスセソ<>/+*=';

/**
 * Blue glyph rain for the loader. One 2D canvas at a fixed 1x scale, capped at
 * ~30 fps, and it stops itself on unmount. Under reduced motion it paints a
 * single static frame instead of animating.
 */
export function GlyphRain({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const size = 16;
    let cols = 0;
    let drops: number[] = [];
    const resize = () => {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      cols = Math.ceil(canvas.width / size);
      drops = Array.from({ length: cols }, () => Math.random() * -40);
      ctx.fillStyle = '#04060a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    };
    resize();
    window.addEventListener('resize', resize);

    const step = () => {
      ctx.fillStyle = 'rgba(4, 6, 10, 0.14)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${size - 2}px ui-monospace, Menlo, monospace`;
      for (let i = 0; i < cols; i++) {
        const y = drops[i] * size;
        const g = GLYPHS[(Math.random() * GLYPHS.length) | 0];
        ctx.fillStyle =
          Math.random() < 0.08 ? '#e9fbff' : i % 3 ? '#2ba7c4' : '#6aa6ff';
        ctx.fillText(g, i * size, y);
        drops[i] =
          y > canvas.height && Math.random() > 0.975 ? 0 : drops[i] + 1;
      }
    };

    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 33) return;
      last = t;
      step();
    };
    if (reduced) for (let i = 0; i < 60; i++) step();
    else raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}

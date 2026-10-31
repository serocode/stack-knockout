import { useEffect, useRef } from "react";
import { SHAPES, PIECE_TYPES, PIECE_CELL } from "@tk/engine";
import { usePrefs } from "../lib/prefs";

/** Slowly drifting tetromino silhouettes behind the menus. Still when reduce-motion is on. */
export function Backdrop() {
  const ref = useRef<HTMLCanvasElement>(null);
  const prefs = usePrefs();
  const live = useRef(prefs);
  live.current = prefs;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    const N = 18;
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const pieces = Array.from({ length: N }, () => ({
      type: PIECE_TYPES[Math.floor(Math.random() * 7)]!,
      x: Math.random(),
      y: Math.random(),
      size: rnd(10, 26),
      speed: rnd(0.004, 0.012),
      rot: rnd(0, Math.PI * 2),
      vr: rnd(-0.0003, 0.0003),
      alpha: rnd(0.05, 0.14),
    }));
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = innerWidth * dpr;
      c.height = innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    addEventListener("resize", resize);
    let last = performance.now();
    const frame = (t: number) => {
      const dt = Math.min(50, t - last);
      last = t;
      const still = live.current.reduceMotion;
      const pal = live.current.cosmetics.palette;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of pieces) {
        if (!still) {
          p.y += (p.speed * dt) / 100;
          p.rot += p.vr * dt;
          if (p.y > 1.1) {
            p.y = -0.1;
            p.x = Math.random();
          }
        }
        const col = pal[PIECE_CELL[p.type] - 1] ?? "#ffffff";
        ctx.save();
        ctx.translate(p.x * innerWidth, p.y * innerHeight);
        ctx.rotate(p.rot);
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = col;
        for (const [cx, cy] of SHAPES[p.type][0]!) {
          ctx.beginPath();
          ctx.roundRect((cx - 1.5) * p.size, (cy - 1) * p.size, p.size - 2, p.size - 2, p.size * 0.2);
          ctx.fill();
        }
        ctx.restore();
      }
      if (!still) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("resize", resize);
    };
  }, [prefs.reduceMotion]);

  return <canvas ref={ref} className="backdrop" aria-hidden />;
}

import type { Effect } from "../cosmetics/catalog";

/**
 * Visual effects on a single full-screen overlay canvas: particle bursts per
 * effect skin, attack projectiles flying between boards, and "trauma" screen
 * shake on board elements. Purely visual: never blocks input, never touches
 * the simulation, and scales down with reduce-motion.
 *
 * Importance tiers (game-feel guidance): 1 small (single/double, lock),
 * 2 medium (triple, mini, combo), 3 large (tetris, T-spin, B2B),
 * 4 huge (perfect clear, KO).
 */
export type Tier = 1 | 2 | 3 | 4;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  life: number;
  max: number;
  size: number;
  color: string;
  shape: "spark" | "square" | "shard" | "ring" | "ember" | "star" | "bolt" | "confetti";
  rot: number;
  vr: number;
  /** For bolts: polyline points. */
  pts?: number[];
}

interface Projectile {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  t: number;
  dur: number;
  effect: Effect;
  size: number;
  onArrive?: () => void;
  lastX: number;
  lastY: number;
}

const STYLE: Record<Effect, { colors: string[]; shape: Particle["shape"]; g: number; speed: number; life: number }> = {
  neon: { colors: ["#3fd7e8", "#ff4fd8", "#b768f2", "#ffffff"], shape: "spark", g: 0, speed: 0.32, life: 520 },
  lightning: { colors: ["#e8f6ff", "#9fd8ff", "#ffffff", "#fff59a"], shape: "spark", g: 0.0004, speed: 0.5, life: 360 },
  fire: { colors: ["#ffb347", "#ff6a2b", "#ffd36b", "#ff3b2f"], shape: "ember", g: -0.0007, speed: 0.22, life: 760 },
  ice: { colors: ["#ffffff", "#cdeeff", "#9bd8ff", "#7fb7ff"], shape: "shard", g: 0.0012, speed: 0.36, life: 700 },
  pixel: { colors: [], shape: "square", g: 0.0011, speed: 0.34, life: 680 },
  cosmic: { colors: ["#ffffff", "#c7a4ff", "#7f9bff", "#ff9bf0"], shape: "star", g: -0.00005, speed: 0.16, life: 1100 },
  confetti: { colors: ["#ff5c8a", "#ffd166", "#06d6a0", "#4cc9f0", "#b388ff", "#ffffff"], shape: "confetti", g: 0.0006, speed: 0.42, life: 1300 },
  supernova: { colors: ["#ffffff", "#bfe3ff", "#7fb2ff", "#ffe9a8"], shape: "spark", g: 0, speed: 0.7, life: 700 },
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pickOf = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]!;

class FxLayer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private parts: Particle[] = [];
  private shots: Projectile[] = [];
  private trauma = new Map<HTMLElement, { v: number; t: number }>();
  private raf = 0;
  private last = 0;
  reduceMotion = false;
  reduceFlashing = false;

  private ensure(): CanvasRenderingContext2D {
    if (this.ctx && this.canvas?.isConnected) return this.ctx;
    const c = document.createElement("canvas");
    c.className = "fx-layer";
    document.body.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext("2d")!;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    return this.ctx;
  }

  private resize(): void {
    if (!this.canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private kick(): void {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private budget(n: number): number {
    return Math.max(1, Math.round(this.reduceMotion ? n * 0.3 : n));
  }

  /** Particle burst over a screen rectangle (e.g. the cleared rows). */
  burst(area: { x: number; y: number; w: number; h: number }, effect: Effect, tier: Tier, palette?: readonly string[]): void {
    this.ensure();
    const st = STYLE[effect];
    const colors = st.colors.length ? st.colors : [...(palette ?? ["#ffffff"])];
    const n = this.budget([0, 14, 26, 44, 80][tier]!);
    const speed = st.speed * (0.8 + tier * 0.15);
    for (let i = 0; i < n; i++) {
      const x = area.x + Math.random() * area.w;
      const y = area.y + Math.random() * area.h;
      const a = effect === "fire" ? rand(-Math.PI * 0.85, -Math.PI * 0.15) : rand(0, Math.PI * 2);
      const sp = rand(0.4, 1) * speed;
      this.parts.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - (effect === "pixel" || effect === "ice" ? 0.12 : 0),
        g: st.g,
        life: 0,
        max: st.life * rand(0.7, 1.2),
        size: rand(2, 4) + tier * 0.6,
        color: pickOf(colors),
        shape: st.shape,
        rot: rand(0, Math.PI * 2),
        vr: effect === "confetti" ? rand(-0.02, 0.02) : rand(-0.01, 0.01),
      });
    }
    if (effect === "supernova" && !this.reduceFlashing) {
      // White core flash that fades fast.
      const cx = area.x + area.w / 2;
      const cy = area.y + area.h / 2;
      this.parts.push({ x: cx, y: cy, vx: 0, vy: 0, g: 0, life: 0, max: 260, size: Math.min(160, Math.max(area.w, area.h) * 0.4) * (0.6 + tier * 0.2), color: "#ffffff", shape: "spark", rot: 0, vr: 0 });
    }
    if (effect === "neon" || effect === "supernova" || tier >= 3) {
      const cx = area.x + area.w / 2;
      const cy = area.y + area.h / 2;
      const rings = effect === "neon" ? Math.min(3, tier) : effect === "supernova" ? 2 + tier : 1;
      for (let i = 0; i < rings; i++) {
        this.parts.push({ x: cx, y: cy, vx: 0, vy: 0, g: 0, life: -i * 90, max: 520, size: Math.min(220, Math.max(area.w, area.h) * (0.3 + tier * 0.1)), color: pickOf(colors), shape: "ring", rot: 0, vr: 0 });
      }
    }
    if (effect === "lightning" && !this.reduceFlashing) {
      for (let i = 0; i < Math.min(4, tier + 1); i++) {
        const y = area.y + Math.random() * area.h;
        this.parts.push({ x: area.x, y, vx: 0, vy: 0, g: 0, life: 0, max: 200, size: 2, color: "#e8f6ff", shape: "bolt", rot: 0, vr: 0, pts: jagged(area.x - 6, y, area.x + area.w + 6, y + rand(-8, 8), 9) });
      }
    }
    this.kick();
  }

  /** Burst over a set of board rows, given the board canvas and cell size. */
  rows(canvas: HTMLCanvasElement, rows: number[], cell: number, effect: Effect, tier: Tier, palette?: readonly string[]): void {
    const r = canvas.getBoundingClientRect();
    for (const row of rows) this.burst({ x: r.left, y: r.top + row * cell, w: r.width, h: cell }, effect, tier, palette);
  }

  /** An attack flying from one element to another along an arc. */
  projectile(from: Element, to: Element, effect: Effect, lines: number, onArrive?: () => void): void {
    this.ensure();
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const x0 = a.left + a.width / 2;
    const y0 = a.top + a.height * 0.45;
    const x1 = b.left + b.width / 2;
    const y1 = b.top + b.height * 0.5;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    this.shots.push({
      x0, y0, x1, y1,
      cx: (x0 + x1) / 2,
      cy: Math.min(y0, y1) - Math.min(160, dist * 0.35),
      t: 0,
      dur: this.reduceMotion ? 260 : 420 + Math.min(250, dist * 0.25),
      effect,
      size: 4 + Math.min(10, lines * 1.4),
      onArrive,
      lastX: x0,
      lastY: y0,
    });
    this.kick();
  }

  /** Add screen-shake trauma to an element (decays; shake = trauma^2). */
  shake(el: HTMLElement | null, amount: number): void {
    if (!el || this.reduceMotion) return;
    this.ensure();
    const cur = this.trauma.get(el) ?? { v: 0, t: Math.random() * 100 };
    cur.v = Math.min(1, cur.v + amount);
    this.trauma.set(el, cur);
    this.kick();
  }

  private frame(now: number): void {
    const dt = Math.min(50, now - this.last);
    this.last = now;
    const ctx = this.ensure();
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    // Projectiles
    for (const p of this.shots) {
      p.t += dt;
      const k = Math.min(1, p.t / p.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const x = (1 - e) * (1 - e) * p.x0 + 2 * (1 - e) * e * p.cx + e * e * p.x1;
      const y = (1 - e) * (1 - e) * p.y0 + 2 * (1 - e) * e * p.cy + e * e * p.y1;
      const st = STYLE[p.effect];
      const col = st.colors[0] ?? "#ffffff";
      // trail
      const steps = this.reduceMotion ? 1 : 3;
      for (let i = 0; i < steps; i++) {
        this.parts.push({
          x: p.lastX + ((x - p.lastX) * i) / steps, y: p.lastY + ((y - p.lastY) * i) / steps,
          vx: rand(-0.03, 0.03), vy: rand(-0.03, 0.03), g: st.g * 0.3, life: 0, max: 260,
          size: p.size * 0.6, color: pickOf(st.colors.length ? st.colors : ["#ffffff", "#ffd36b"]),
          shape: p.effect === "pixel" ? "square" : p.effect === "ice" ? "shard" : "spark", rot: rand(0, 6), vr: 0,
        });
      }
      p.lastX = x;
      p.lastY = y;
      ctx.save();
      ctx.shadowColor = col;
      ctx.shadowBlur = p.size * 2.5;
      ctx.fillStyle = p.effect === "fire" ? "#ffd36b" : "#ffffff";
      ctx.beginPath();
      ctx.arc(x, y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (k >= 1) {
        this.burst({ x: p.x1 - 20, y: p.y1 - 20, w: 40, h: 40 }, p.effect, 1);
        p.onArrive?.();
      }
    }
    this.shots = this.shots.filter((p) => p.t < p.dur);

    // Particles
    const keep: Particle[] = [];
    for (const q of this.parts) {
      q.life += dt;
      if (q.life < 0) {
        keep.push(q);
        continue;
      }
      if (q.life > q.max) continue;
      q.vy += q.g * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.rot += q.vr * dt;
      const a = 1 - q.life / q.max;
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle = q.color;
      ctx.strokeStyle = q.color;
      switch (q.shape) {
        case "spark":
        case "ember": {
          const sz = q.shape === "ember" ? q.size * (0.4 + a * 0.8) : q.size * a + 0.5;
          ctx.beginPath();
          ctx.arc(q.x, q.y, sz, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case "square":
          ctx.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
          break;
        case "confetti": {
          // Flutter: drag sideways and flip (scaleY by cos of rotation).
          q.vx *= 0.985;
          ctx.save();
          ctx.translate(q.x, q.y);
          ctx.rotate(q.rot);
          ctx.scale(1, Math.cos(q.life / 90));
          ctx.fillRect(-q.size * 0.7, -q.size * 0.35, q.size * 1.4, q.size * 0.7);
          ctx.restore();
          break;
        }
        case "shard":
          ctx.save();
          ctx.translate(q.x, q.y);
          ctx.rotate(q.rot);
          ctx.beginPath();
          ctx.moveTo(0, -q.size * 1.4);
          ctx.lineTo(q.size * 0.6, q.size * 0.8);
          ctx.lineTo(-q.size * 0.6, q.size * 0.8);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          break;
        case "star": {
          const s = q.size * (0.6 + 0.4 * Math.sin(q.life / 60));
          ctx.fillRect(q.x - s / 2, q.y - 0.5, s, 1);
          ctx.fillRect(q.x - 0.5, q.y - s / 2, 1, s);
          ctx.beginPath();
          ctx.arc(q.x, q.y, 1.1, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case "ring": {
          const r = q.size * (1 - Math.pow(a, 2));
          ctx.lineWidth = 2 + 3 * a;
          ctx.beginPath();
          ctx.arc(q.x, q.y, Math.max(1, r), 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case "bolt": {
          const pts = q.pts!;
          ctx.lineWidth = 2;
          ctx.shadowColor = "#9fd8ff";
          ctx.shadowBlur = 10;
          ctx.beginPath();
          ctx.moveTo(pts[0]!, pts[1]!);
          for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
          ctx.stroke();
          ctx.shadowBlur = 0;
          break;
        }
      }
      keep.push(q);
    }
    ctx.globalAlpha = 1;
    this.parts = keep.length > 1500 ? keep.slice(-1500) : keep;

    // Shake
    for (const [el, tr] of this.trauma) {
      tr.v = Math.max(0, tr.v - dt * 0.0022);
      tr.t += dt * 0.03;
      const s = tr.v * tr.v;
      if (s <= 0.0001 || !el.isConnected) {
        el.style.transform = "";
        this.trauma.delete(el);
        continue;
      }
      el.style.transform = `translate(${(10 * s * Math.sin(tr.t * 1.7)).toFixed(2)}px, ${(7 * s * Math.sin(tr.t * 2.3)).toFixed(2)}px) rotate(${(1.2 * s * Math.sin(tr.t * 1.1)).toFixed(3)}deg)`;
    }

    if (this.parts.length || this.shots.length || this.trauma.size) this.raf = requestAnimationFrame((t) => this.frame(t));
    else {
      this.raf = 0;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }
}

function jagged(x0: number, y0: number, x1: number, y1: number, n: number): number[] {
  const pts = [x0, y0];
  for (let i = 1; i < n; i++) {
    const k = i / n;
    pts.push(x0 + (x1 - x0) * k + rand(-4, 4), y0 + (y1 - y0) * k + rand(-9, 9));
  }
  pts.push(x1, y1);
  return pts;
}

export const fx = new FxLayer();

/** Map a lock result to a feedback tier. */
export function tierFor(r: { lines: number; tspin: "none" | "mini" | "full"; perfectClear: boolean; b2bBonus: boolean; combo: number }): Tier | 0 {
  if (r.perfectClear) return 4;
  if (r.lines === 0) return 0;
  if (r.lines === 4 || (r.tspin === "full" && r.lines > 0) || r.b2bBonus) return 3;
  if (r.lines === 3 || r.tspin === "mini" || r.combo >= 3) return 2;
  return 1;
}

export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}

import type { Background, BlockCorners, BlockGap, BlockGlow, BlockPattern, BlockSkin, Bomb, Garbage, Ghost } from "../cosmetics/catalog";

/**
 * Canvas painters for every block skin, block shape option, ghost style,
 * garbage style and board background. Read-only view code: nothing here can
 * touch simulation state.
 *
 * Pipeline per block: skin painter -> scale for gap -> pattern overlay ->
 * corner mask -> baked glow, all rendered once into a cached sprite. Animated
 * skins loop over 16 frames, so they are cached too.
 */

export interface Look {
  skin: BlockSkin;
  /** 7 colours in engine cell order I O T S Z J L (cell values 1..7). */
  palette: readonly string[];
  background: Background;
  ghost: Ghost;
  garbage: Garbage;
  /** Bomb cell style (cell value 9). */
  bomb?: Bomb;
  corners?: BlockCorners;
  gap?: BlockGap;
  pattern?: BlockPattern;
  glow?: BlockGlow;
}

// ------------------------------------------------------------------ colours

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
export function shade(hex: string, amt: number): string {
  const [r, g, b] = rgb(hex);
  const t = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  return `rgb(${clamp(r + (t - r) * p)},${clamp(g + (t - g) * p)},${clamp(b + (t - b) * p)})`;
}
export function rgba(hex: string, a: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function mixHex(hex: string, other: string, p: number): string {
  const [r, g, b] = rgb(hex);
  const [r2, g2, b2] = rgb(other);
  const h = (v: number) => clamp(v).toString(16).padStart(2, "0");
  return `#${h(r + (r2 - r) * p)}${h(g + (g2 - g) * p)}${h(b + (b2 - b) * p)}`;
}
function hueOf(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

export const GARBAGE_COLOR = "#737887";

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ block skins

/** t is a loop phase 0..1 for animated skins (ignored by static ones). */
type Painter = (ctx: CanvasRenderingContext2D, s: number, color: string, t: number) => void;

const PAINTERS: Record<BlockSkin, Painter> = {
  classic(ctx, s, c) {
    ctx.fillStyle = c;
    ctx.fillRect(1, 1, s - 2, s - 2);
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.fillRect(1, 1, s - 2, Math.max(2, s * 0.18));
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(1, s - 1 - Math.max(2, s * 0.14), s - 2, Math.max(2, s * 0.14));
  },
  neon(ctx, s, c) {
    const lw = Math.max(1.5, s * 0.1);
    ctx.fillStyle = rgba(c, 0.14);
    ctx.fillRect(2, 2, s - 4, s - 4);
    ctx.shadowColor = c;
    ctx.shadowBlur = s * 0.45;
    ctx.strokeStyle = c;
    ctx.lineWidth = lw;
    ctx.strokeRect(1 + lw / 2 + 1, 1 + lw / 2 + 1, s - 4 - lw, s - 4 - lw);
    ctx.shadowBlur = 0;
    ctx.fillStyle = rgba("#ffffff", 0.55);
    ctx.fillRect(s * 0.28, s * 0.28, Math.max(1, s * 0.12), Math.max(1, s * 0.12));
  },
  glass(ctx, s, c) {
    const g = ctx.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0, rgba(c, 0.7));
    g.addColorStop(1, rgba(c, 0.28));
    ctx.fillStyle = g;
    roundRect(ctx, 1, 1, s - 2, s - 2, s * 0.12);
    ctx.fill();
    ctx.strokeStyle = rgba(c, 0.95);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath();
    ctx.moveTo(s * 0.18, s * 0.18);
    ctx.lineTo(s * 0.55, s * 0.18);
    ctx.lineTo(s * 0.18, s * 0.55);
    ctx.closePath();
    ctx.fill();
  },
  pixel(ctx, s, c) {
    const u = s / 5;
    ctx.fillStyle = shade(c, -0.45);
    ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = c;
    ctx.fillRect(u * 0.5, u * 0.5, s - u, s - u);
    ctx.fillStyle = shade(c, 0.35);
    ctx.fillRect(u * 0.5, u * 0.5, s - u, u);
    ctx.fillRect(u * 0.5, u * 0.5, u, s - u);
    ctx.fillStyle = shade(c, -0.25);
    ctx.fillRect(u * 0.5, s - u * 1.5, s - u, u);
    ctx.fillRect(s - u * 1.5, u * 0.5, u, s - u);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(u * 1.5, u * 1.5, u, u);
  },
  gradient(ctx, s, c) {
    const g = ctx.createLinearGradient(0, 0, s, s);
    g.addColorStop(0, shade(c, 0.3));
    g.addColorStop(1, shade(c, -0.35));
    ctx.fillStyle = g;
    roundRect(ctx, 1, 1, s - 2, s - 2, s * 0.16);
    ctx.fill();
  },
  metallic(ctx, s, c) {
    const base = mixHex(c, "#9aa3b5", 0.45);
    const g = ctx.createLinearGradient(0, 0, 0, s);
    g.addColorStop(0, shade(base, 0.45));
    g.addColorStop(0.45, base);
    g.addColorStop(0.55, shade(base, -0.35));
    g.addColorStop(1, shade(base, 0.1));
    ctx.fillStyle = g;
    ctx.fillRect(1, 1, s - 2, s - 2);
    ctx.fillStyle = rgba(c, 0.35);
    ctx.fillRect(1, 1, s - 2, s - 2);
    ctx.strokeStyle = shade(base, -0.5);
    ctx.lineWidth = 1;
    ctx.strokeRect(1.5, 1.5, s - 3, s - 3);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.beginPath();
    ctx.moveTo(2, s * 0.3);
    ctx.lineTo(s - 2, s * 0.22);
    ctx.stroke();
  },
  cyber(ctx, s, c) {
    ctx.fillStyle = mixHex(c, "#0b0e16", 0.78);
    ctx.fillRect(1, 1, s - 2, s - 2);
    const L = s * 0.34;
    const w = Math.max(1.5, s * 0.09);
    ctx.strokeStyle = c;
    ctx.lineWidth = w;
    ctx.shadowColor = c;
    ctx.shadowBlur = s * 0.25;
    const o = 1 + w / 2;
    ctx.beginPath();
    ctx.moveTo(o, o + L); ctx.lineTo(o, o); ctx.lineTo(o + L, o);
    ctx.moveTo(s - o - L, s - o); ctx.lineTo(s - o, s - o); ctx.lineTo(s - o, s - o - L);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = rgba(c, 0.85);
    ctx.fillRect(s * 0.42, s * 0.42, s * 0.16, s * 0.16);
    ctx.strokeStyle = rgba(c, 0.45);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s * 0.58, s * 0.5);
    ctx.lineTo(s - o - 1, s * 0.5);
    ctx.stroke();
  },
  liquid(ctx, s, c, t) {
    const wob = Math.sin(t * Math.PI * 2 + c.charCodeAt(2)) * 0.12;
    const g = ctx.createRadialGradient(s * (0.32 + wob), s * (0.3 - wob * 0.5), s * 0.05, s * 0.5, s * 0.5, s * 0.75);
    g.addColorStop(0, shade(c, 0.55));
    g.addColorStop(0.45, c);
    g.addColorStop(1, shade(c, -0.4));
    ctx.fillStyle = g;
    roundRect(ctx, 1, 1, s - 2, s - 2, s * 0.36);
    ctx.fill();
  },
  candy(ctx, s, c) {
    ctx.fillStyle = c;
    roundRect(ctx, 1, 1, s - 2, s - 2, s * 0.2);
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    const w = s / 5;
    for (let i = -s; i < s * 2; i += w * 2) {
      ctx.beginPath();
      ctx.moveTo(i, 0); ctx.lineTo(i + w, 0); ctx.lineTo(i + w - s, s); ctx.lineTo(i - s, s);
      ctx.closePath();
      ctx.fill();
    }
    const g = ctx.createLinearGradient(0, 0, 0, s * 0.5);
    g.addColorStop(0, "rgba(255,255,255,0.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s * 0.5);
    ctx.restore();
  },
  bubble(ctx, s, c) {
    const g = ctx.createRadialGradient(s * 0.35, s * 0.32, s * 0.04, s * 0.5, s * 0.5, s * 0.52);
    g.addColorStop(0, shade(c, 0.65));
    g.addColorStop(0.55, c);
    g.addColorStop(1, shade(c, -0.35));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s * 0.46, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.beginPath();
    ctx.ellipse(s * 0.34, s * 0.28, s * 0.1, s * 0.06, -0.6, 0, Math.PI * 2);
    ctx.fill();
  },
  outline(ctx, s, c) {
    ctx.fillStyle = rgba(c, 0.1);
    ctx.fillRect(2, 2, s - 4, s - 4);
    ctx.strokeStyle = c;
    ctx.lineWidth = Math.max(1.5, s * 0.1);
    const o = ctx.lineWidth / 2 + 1.5;
    ctx.strokeRect(o, o, s - o * 2, s - o * 2);
  },
  retro(ctx, s, c) {
    ctx.fillStyle = c;
    ctx.fillRect(1, 1, s - 2, s - 2);
    ctx.fillStyle = "rgba(255,40,80,0.45)";
    ctx.fillRect(1, 1, Math.max(1, s * 0.07), s - 2);
    ctx.fillStyle = "rgba(40,220,255,0.45)";
    ctx.fillRect(s - 1 - Math.max(1, s * 0.07), 1, Math.max(1, s * 0.07), s - 2);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    for (let y = 2; y < s - 1; y += Math.max(2, Math.round(s / 8))) ctx.fillRect(1, y, s - 2, 1);
    const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.1, s / 2, s / 2, s * 0.7);
    g.addColorStop(0, "rgba(255,255,255,0.18)");
    g.addColorStop(1, "rgba(0,0,0,0.2)");
    ctx.fillStyle = g;
    ctx.fillRect(1, 1, s - 2, s - 2);
  },
  paper(ctx, s, c) {
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(Math.max(2, s * 0.12), Math.max(2, s * 0.12), s - 3, s - 3);
    ctx.fillStyle = mixHex(c, "#f4efe6", 0.18);
    ctx.fillRect(1, 1, s - 1 - Math.max(2, s * 0.1), s - 1 - Math.max(2, s * 0.1));
    const r = seeded(c.charCodeAt(1) * 31 + c.charCodeAt(4));
    ctx.fillStyle = "rgba(0,0,0,0.07)";
    for (let i = 0; i < 6; i++) ctx.fillRect(1 + r() * (s - 6), 1 + r() * (s - 6), 1, 1);
  },
  // ---------------- premium (animated)
  gold(ctx, s, c, t) {
    const base = mixHex(c, "#e8b84a", 0.62);
    const g = ctx.createLinearGradient(0, 0, s, s);
    g.addColorStop(0, shade(base, 0.55));
    g.addColorStop(0.35, base);
    g.addColorStop(0.65, shade(base, -0.35));
    g.addColorStop(1, shade(base, 0.2));
    ctx.fillStyle = g;
    ctx.fillRect(1, 1, s - 2, s - 2);
    ctx.strokeStyle = shade(base, -0.45);
    ctx.lineWidth = Math.max(1, s * 0.06);
    ctx.strokeRect(2, 2, s - 4, s - 4);
    ctx.strokeStyle = rgba("#fff4c2", 0.6);
    ctx.lineWidth = 1;
    ctx.strokeRect(s * 0.22, s * 0.22, s * 0.56, s * 0.56);
    // sweeping sheen
    const x = -s + t * s * 3;
    const sh = ctx.createLinearGradient(x, 0, x + s * 0.6, s * 0.6);
    sh.addColorStop(0, "rgba(255,255,255,0)");
    sh.addColorStop(0.5, "rgba(255,255,255,0.65)");
    sh.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sh;
    ctx.fillRect(1, 1, s - 2, s - 2);
  },
  lava(ctx, s, c, t) {
    ctx.fillStyle = mixHex(c, "#1a0a06", 0.72);
    ctx.fillRect(1, 1, s - 2, s - 2);
    const glow = 0.55 + 0.45 * Math.sin(t * Math.PI * 2);
    const hot = mixHex(c, "#ff7a1a", 0.6);
    ctx.strokeStyle = rgba(hot, 0.6 + glow * 0.4);
    ctx.shadowColor = hot;
    ctx.shadowBlur = s * 0.35 * glow;
    ctx.lineWidth = Math.max(1, s * 0.07);
    const r = seeded(c.charCodeAt(3) * 17);
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      let x = s * (0.15 + r() * 0.7);
      let y = 2;
      ctx.moveTo(x, y);
      while (y < s - 2) {
        x += (r() - 0.5) * s * 0.35;
        y += s * (0.18 + r() * 0.15);
        ctx.lineTo(Math.max(2, Math.min(s - 2, x)), Math.min(s - 2, y));
      }
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  },
  galaxy(ctx, s, c, t) {
    ctx.fillStyle = mixHex(c, "#070414", 0.8);
    ctx.fillRect(1, 1, s - 2, s - 2);
    const neb = ctx.createRadialGradient(s * (0.35 + 0.1 * Math.sin(t * Math.PI * 2)), s * 0.45, 1, s * 0.5, s * 0.5, s * 0.6);
    neb.addColorStop(0, rgba(c, 0.85));
    neb.addColorStop(0.5, rgba(mixHex(c, "#7a3cff", 0.5), 0.35));
    neb.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = neb;
    ctx.fillRect(1, 1, s - 2, s - 2);
    const r = seeded(c.charCodeAt(5) * 13);
    for (let i = 0; i < 5; i++) {
      const tw = 0.4 + 0.6 * Math.abs(Math.sin((t + i / 5) * Math.PI * 2));
      ctx.fillStyle = `rgba(255,255,255,${tw})`;
      const x = 2 + r() * (s - 4);
      const y = 2 + r() * (s - 4);
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.strokeStyle = rgba(c, 0.6);
    ctx.lineWidth = 1;
    ctx.strokeRect(1.5, 1.5, s - 3, s - 3);
  },
  prism(ctx, s, c, t) {
    const h = hueOf(c) + t * 360;
    const g = ctx.createLinearGradient(0, 0, s, s);
    g.addColorStop(0, `hsl(${h % 360}, 90%, 72%)`);
    g.addColorStop(0.5, `hsl(${(h + 70) % 360}, 90%, 62%)`);
    g.addColorStop(1, `hsl(${(h + 150) % 360}, 90%, 55%)`);
    ctx.fillStyle = g;
    ctx.fillRect(1, 1, s - 2, s - 2);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(1, 1); ctx.lineTo(s - 1, s - 1);
    ctx.moveTo(s - 1, 1); ctx.lineTo(s * 0.5, s * 0.5);
    ctx.stroke();
    ctx.fillStyle = rgba(c, 0.25);
    ctx.fillRect(1, 1, s - 2, s - 2);
  },
  diamond(ctx, s, c, t) {
    const m = s / 2;
    const facets: [number, number, number, number, number, number, number][] = [
      [1, 1, s - 1, 1, m, m, 0.45],
      [s - 1, 1, s - 1, s - 1, m, m, 0.1],
      [s - 1, s - 1, 1, s - 1, m, m, -0.35],
      [1, s - 1, 1, 1, m, m, 0.2],
    ];
    const base = mixHex(c, "#e9f6ff", 0.25);
    for (const [x1, y1, x2, y2, x3, y3, l] of facets) {
      ctx.fillStyle = shade(base, l);
      ctx.beginPath();
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = shade(base, 0.6);
    ctx.fillRect(m - s * 0.14, m - s * 0.14, s * 0.28, s * 0.28);
    // a sparkle that travels around the gem once per loop
    const a = t * Math.PI * 2;
    const sx = m + Math.cos(a) * s * 0.28;
    const sy = m + Math.sin(a) * s * 0.28;
    const k = s * 0.22 * (0.5 + 0.5 * Math.sin(a * 3));
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.moveTo(sx, sy - k); ctx.lineTo(sx + k * 0.22, sy); ctx.lineTo(sx, sy + k); ctx.lineTo(sx - k * 0.22, sy);
    ctx.closePath();
    ctx.fill();
  },
};

/** Skins that animate (rendered as a 16-frame loop). */
export const ANIMATED: ReadonlySet<BlockSkin> = new Set(["liquid", "gold", "lava", "galaxy", "prism", "diamond"]);
const FRAMES_PER_LOOP = 16;
const LOOP_MS: Partial<Record<BlockSkin, number>> = { liquid: 2600, gold: 2400, lava: 1800, galaxy: 3200, prism: 4000, diamond: 2200 };

function patternOverlay(ctx: CanvasRenderingContext2D, s: number, p: BlockPattern, t: number): void {
  if (p === "none") return;
  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  switch (p) {
    case "stripes":
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      for (let i = -s; i < s * 2; i += s / 3) {
        ctx.beginPath();
        ctx.moveTo(i, 0); ctx.lineTo(i + s / 7, 0); ctx.lineTo(i + s / 7 - s, s); ctx.lineTo(i - s, s);
        ctx.closePath();
        ctx.fill();
      }
      break;
    case "dots":
      ctx.fillStyle = "rgba(0,0,0,0.2)";
      for (let y = s / 6; y < s; y += s / 3) for (let x = s / 6; x < s; x += s / 3) {
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.8, s * 0.05), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case "scanlines":
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      for (let y = 1; y < s; y += 3) ctx.fillRect(0, y, s, 1);
      break;
    case "checker": {
      const q = s / 4;
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if ((x + y) % 2) ctx.fillRect(x * q, y * q, q, q);
      break;
    }
    case "sparkle": {
      const r = seeded(Math.round(s * 7));
      for (let i = 0; i < 3; i++) {
        const x = s * (0.15 + r() * 0.7);
        const y = s * (0.15 + r() * 0.7);
        const k = s * 0.12 * (0.4 + 0.6 * Math.abs(Math.sin((t + i / 3) * Math.PI * 2)));
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillRect(x - k, y - 0.5, k * 2, 1);
        ctx.fillRect(x - 0.5, y - k, 1, k * 2);
      }
      break;
    }
  }
  ctx.restore();
}

const CORNER_R: Record<BlockCorners, number> = { sharp: 0, soft: 0.18, round: 0.4 };
const GLOW_BLUR: Record<BlockGlow, number> = { off: 0, soft: 0.35, strong: 0.7 };

const spriteCache = new Map<string, HTMLCanvasElement>();
const DPR = () => Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

/**
 * Renders a full block (skin + shape options) into a cached sprite with
 * padding for the glow. Returns [sprite, pad] in CSS pixels.
 */
function blockSprite(key: string, s: number, color: string, paint: Painter, phase: number, look: Look): [HTMLCanvasElement, number] {
  const glow = GLOW_BLUR[look.glow ?? "off"];
  const pad = glow ? Math.ceil(s * glow) : 0;
  const hit = spriteCache.get(key);
  if (hit) return [hit, pad];
  const dpr = DPR();
  // 1. skin at full size
  const cell = makeCanvas(s * dpr, s * dpr);
  const cctx = cell.getContext("2d")!;
  cctx.scale(dpr, dpr);
  const inset = look.gap === "wide" ? Math.max(1, s * 0.08) : look.gap === "tight" ? -1 : 0;
  cctx.save();
  cctx.translate(inset, inset);
  cctx.scale((s - inset * 2) / s, (s - inset * 2) / s);
  paint(cctx, s, color, phase);
  cctx.restore();
  // 2. pattern
  patternOverlay(cctx, s, look.pattern ?? "none", phase);
  // 3. corner mask
  const r = CORNER_R[look.corners ?? "sharp"] * s;
  if (r > 0) {
    cctx.save();
    cctx.globalCompositeOperation = "destination-in";
    roundRect(cctx, Math.max(0, inset), Math.max(0, inset), s - Math.max(0, inset) * 2, s - Math.max(0, inset) * 2, r);
    cctx.fillStyle = "#000";
    cctx.fill();
    cctx.restore();
  }
  // 4. glow, baked into a padded sprite
  let out = cell;
  if (pad) {
    out = makeCanvas((s + pad * 2) * dpr, (s + pad * 2) * dpr);
    const o = out.getContext("2d")!;
    o.shadowColor = color;
    o.shadowBlur = s * glow * dpr;
    o.drawImage(cell, pad * dpr, pad * dpr);
    o.shadowBlur = 0;
    o.drawImage(cell, pad * dpr, pad * dpr);
  }
  if (spriteCache.size > 2500) spriteCache.clear();
  spriteCache.set(key, out);
  return [out, pad];
}

function shapeKey(look: Look): string {
  return `${look.corners ?? "sharp"}|${look.gap ?? "normal"}|${look.pattern ?? "none"}|${look.glow ?? "off"}`;
}

function phaseFor(skin: BlockSkin, t: number, pattern: BlockPattern | undefined): [number, number] {
  const animated = ANIMATED.has(skin) || pattern === "sparkle";
  if (!animated) return [0, 0];
  const loop = LOOP_MS[skin] ?? 2400;
  const frame = Math.floor(((t % loop) / loop) * FRAMES_PER_LOOP);
  return [frame / FRAMES_PER_LOOP, frame];
}

function drawSkinned(ctx: CanvasRenderingContext2D, px: number, py: number, s: number, color: string, skin: BlockSkin, look: Look, t: number): void {
  const [phase, frame] = phaseFor(skin, t, look.pattern);
  const [img, pad] = blockSprite(`${skin}|${color}|${s}|${shapeKey(look)}|${frame}`, s, color, PAINTERS[skin], phase, look);
  ctx.drawImage(img, px - pad, py - pad, s + pad * 2, s + pad * 2);
}

/** Draw one block. value 1..7 = piece colour, 8 = garbage, 9 = bomb garbage. gx/gy pick deterministic garbage texture. */
export function drawBlock(ctx: CanvasRenderingContext2D, px: number, py: number, s: number, value: number, look: Look, t: number, gx = 0, gy = 0): void {
  if (value === 8) return drawGarbage(ctx, px, py, s, look, t, gx, gy);
  if (value === 9) {
    drawGarbage(ctx, px, py, s, look, t, gx, gy);
    return drawBomb(ctx, px, py, s, look.bomb ?? "classic", t, gx, gy);
  }
  drawSkinned(ctx, px, py, s, look.palette[value - 1] ?? "#888888", look.skin, look, t);
}

function staticSprite(key: string, s: number, paint: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  let c = spriteCache.get(key);
  if (c) return c;
  const dpr = DPR();
  c = makeCanvas(s * dpr, s * dpr);
  const ctx = c.getContext("2d")!;
  ctx.scale(dpr, dpr);
  paint(ctx);
  spriteCache.set(key, c);
  return c;
}

function drawGarbage(ctx: CanvasRenderingContext2D, px: number, py: number, s: number, look: Look, t: number, gx: number, gy: number): void {
  switch (look.garbage) {
    case "skin":
      return drawSkinned(ctx, px, py, s, GARBAGE_COLOR, look.skin, { ...look, glow: "off" }, t);
    case "stone": {
      const v = (gx * 7 + gy * 13) % 4;
      ctx.drawImage(
        staticSprite(`g-stone|${v}|${s}`, s, (c) => {
          PAINTERS.classic(c, s, GARBAGE_COLOR, 0);
          c.fillStyle = "rgba(0,0,0,0.22)";
          const dots = [[0.3, 0.4], [0.65, 0.3], [0.5, 0.7], [0.25, 0.75]] as const;
          for (let i = 0; i <= v; i++) c.fillRect(s * dots[i]![0], s * dots[i]![1], Math.max(1, s * 0.09), Math.max(1, s * 0.09));
        }),
        px, py, s, s,
      );
      return;
    }
    case "crate":
      ctx.drawImage(
        staticSprite(`g-crate|${s}`, s, (c) => {
          c.fillStyle = "#6e6150";
          c.fillRect(1, 1, s - 2, s - 2);
          c.strokeStyle = "#4b4033";
          c.lineWidth = Math.max(1, s * 0.08);
          c.strokeRect(2, 2, s - 4, s - 4);
          c.beginPath();
          c.moveTo(3, 3); c.lineTo(s - 3, s - 3);
          c.moveTo(s - 3, 3); c.lineTo(3, s - 3);
          c.stroke();
        }),
        px, py, s, s,
      );
      return;
    case "hazard":
      ctx.drawImage(
        staticSprite(`g-hazard|${s}`, s, (c) => {
          c.fillStyle = "#2a2a2e";
          c.fillRect(1, 1, s - 2, s - 2);
          c.save();
          c.beginPath();
          c.rect(1, 1, s - 2, s - 2);
          c.clip();
          c.fillStyle = "#b8922c";
          const w = s / 3;
          for (let i = -2; i < 4; i++) {
            c.beginPath();
            c.moveTo(i * w * 2, 0); c.lineTo(i * w * 2 + w, 0); c.lineTo(i * w * 2 + w - s, s); c.lineTo(i * w * 2 - s, s);
            c.closePath();
            c.fill();
          }
          c.restore();
        }),
        px, py, s, s,
      );
      return;
  }
}

// ------------------------------------------------------------------ bombs

/** Static bomb bodies (cached per size); the animated sparkle/pulse is drawn live on top. */
const BOMB_BODY: Record<Bomb, (c: CanvasRenderingContext2D, s: number) => void> = {
  classic(c, s) {
    backdrop(c, s, "rgba(10,10,14,0.55)");
    const g = c.createRadialGradient(s * 0.42, s * 0.48, s * 0.03, s * 0.5, s * 0.58, s * 0.34);
    g.addColorStop(0, "#5b5f6e");
    g.addColorStop(1, "#111217");
    c.fillStyle = g;
    c.beginPath();
    c.arc(s * 0.5, s * 0.58, s * 0.3, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#2b2d36";
    c.fillRect(s * 0.6, s * 0.22, s * 0.14, s * 0.12);
    c.strokeStyle = "#c9a36a";
    c.lineWidth = Math.max(1, s * 0.06);
    c.beginPath();
    c.moveTo(s * 0.67, s * 0.23);
    c.quadraticCurveTo(s * 0.72, s * 0.08, s * 0.84, s * 0.14);
    c.stroke();
    c.fillStyle = "rgba(255,255,255,0.35)";
    c.beginPath();
    c.arc(s * 0.4, s * 0.48, s * 0.07, 0, Math.PI * 2);
    c.fill();
  },
  mine(c, s) {
    backdrop(c, s, "rgba(10,14,12,0.55)");
    c.strokeStyle = "#3a4440";
    c.lineWidth = Math.max(1, s * 0.09);
    c.lineCap = "round";
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      c.beginPath();
      c.moveTo(s * 0.5 + Math.cos(a) * s * 0.2, s * 0.5 + Math.sin(a) * s * 0.2);
      c.lineTo(s * 0.5 + Math.cos(a) * s * 0.4, s * 0.5 + Math.sin(a) * s * 0.4);
      c.stroke();
    }
    const g = c.createRadialGradient(s * 0.42, s * 0.42, s * 0.02, s * 0.5, s * 0.5, s * 0.27);
    g.addColorStop(0, "#6c7a74");
    g.addColorStop(1, "#1d2422");
    c.fillStyle = g;
    c.beginPath();
    c.arc(s * 0.5, s * 0.5, s * 0.26, 0, Math.PI * 2);
    c.fill();
  },
  dynamite(c, s) {
    backdrop(c, s, "rgba(20,8,8,0.5)");
    for (let i = 0; i < 3; i++) {
      const x = s * (0.24 + i * 0.18);
      const g = c.createLinearGradient(x, 0, x + s * 0.17, 0);
      g.addColorStop(0, "#d8423a");
      g.addColorStop(0.5, "#ff6b5e");
      g.addColorStop(1, "#9e221c");
      c.fillStyle = g;
      c.fillRect(x, s * 0.3, s * 0.17, s * 0.58);
    }
    c.fillStyle = "#2a2120";
    c.fillRect(s * 0.2, s * 0.55, s * 0.6, s * 0.1);
    c.strokeStyle = "#c9a36a";
    c.lineWidth = Math.max(1, s * 0.06);
    c.beginPath();
    c.moveTo(s * 0.5, s * 0.3);
    c.quadraticCurveTo(s * 0.52, s * 0.14, s * 0.7, s * 0.14);
    c.stroke();
  },
  core(c, s) {
    backdrop(c, s, "rgba(6,10,20,0.6)");
    c.strokeStyle = "#5d6b8a";
    c.lineWidth = Math.max(1, s * 0.08);
    c.beginPath();
    c.arc(s * 0.5, s * 0.5, s * 0.32, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = "#2b3550";
    c.lineWidth = Math.max(1, s * 0.05);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      c.beginPath();
      c.moveTo(s * 0.5 + Math.cos(a) * s * 0.32, s * 0.5 + Math.sin(a) * s * 0.32);
      c.lineTo(s * 0.5 + Math.cos(a) * s * 0.44, s * 0.5 + Math.sin(a) * s * 0.44);
      c.stroke();
    }
  },
  crystal(c, s) {
    backdrop(c, s, "rgba(16,6,24,0.55)");
    const pts: [number, number][] = [[0.5, 0.12], [0.8, 0.42], [0.5, 0.9], [0.2, 0.42]];
    const g = c.createLinearGradient(0, s * 0.12, 0, s * 0.9);
    g.addColorStop(0, "#f3c8ff");
    g.addColorStop(0.5, "#b05cf0");
    g.addColorStop(1, "#5a1d8f");
    c.fillStyle = g;
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(x * s, y * s) : c.moveTo(x * s, y * s)));
    c.closePath();
    c.fill();
    c.strokeStyle = "rgba(255,255,255,0.45)";
    c.lineWidth = Math.max(1, s * 0.035);
    c.beginPath();
    c.moveTo(s * 0.2, s * 0.42); c.lineTo(s * 0.8, s * 0.42);
    c.moveTo(s * 0.5, s * 0.12); c.lineTo(s * 0.38, s * 0.42); c.lineTo(s * 0.5, s * 0.9);
    c.moveTo(s * 0.5, s * 0.12); c.lineTo(s * 0.62, s * 0.42); c.lineTo(s * 0.5, s * 0.9);
    c.stroke();
  },
  atomic(c, s) {
    backdrop(c, s, "rgba(8,16,6,0.6)");
    c.fillStyle = "#f2d43a";
    c.beginPath();
    c.arc(s * 0.5, s * 0.5, s * 0.36, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#16160f";
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / 3;
      c.beginPath();
      c.moveTo(s * 0.5, s * 0.5);
      c.arc(s * 0.5, s * 0.5, s * 0.31, a - Math.PI / 6, a + Math.PI / 6);
      c.closePath();
      c.fill();
    }
    c.fillStyle = "#f2d43a";
    c.beginPath();
    c.arc(s * 0.5, s * 0.5, s * 0.1, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#16160f";
    c.beginPath();
    c.arc(s * 0.5, s * 0.5, s * 0.06, 0, Math.PI * 2);
    c.fill();
  },
};

function backdrop(c: CanvasRenderingContext2D, s: number, color: string): void {
  c.fillStyle = color;
  c.fillRect(s * 0.08, s * 0.08, s * 0.84, s * 0.84);
}

function spark(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, k: number): void {
  const r = s * (0.07 + 0.05 * k);
  ctx.fillStyle = `rgba(255,170,60,${0.35 + 0.3 * k})`;
  ctx.beginPath();
  ctx.arc(x, y, r * 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff4c2";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawBomb(ctx: CanvasRenderingContext2D, px: number, py: number, s: number, style: Bomb, t: number, gx: number, gy: number): void {
  ctx.drawImage(staticSprite(`bomb|${style}|${s}`, s, (c) => BOMB_BODY[style](c, s)), px, py, s, s);
  // Per-cell phase offset so a column of bombs doesn't pulse in lockstep.
  const ph = t / 1000 + (gx * 0.37 + gy * 0.61);
  const wave = 0.5 + 0.5 * Math.sin(ph * 9);
  ctx.save();
  switch (style) {
    case "classic":
      spark(ctx, px + s * 0.84, py + s * 0.14, s, (0.5 + 0.5 * Math.sin(ph * 31)) * wave);
      break;
    case "dynamite":
      spark(ctx, px + s * 0.7, py + s * 0.14, s, (0.5 + 0.5 * Math.sin(ph * 29)) * wave);
      break;
    case "mine": {
      const on = Math.sin(ph * 6) > 0;
      ctx.fillStyle = on ? "#ff4b3e" : "#5a1a16";
      ctx.beginPath();
      ctx.arc(px + s * 0.5, py + s * 0.5, s * 0.09, 0, Math.PI * 2);
      ctx.fill();
      if (on) {
        ctx.fillStyle = "rgba(255,75,62,0.3)";
        ctx.beginPath();
        ctx.arc(px + s * 0.5, py + s * 0.5, s * 0.2, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "core": {
      const k = 0.5 + 0.5 * Math.sin(ph * 4);
      const g = ctx.createRadialGradient(px + s * 0.5, py + s * 0.5, 0, px + s * 0.5, py + s * 0.5, s * 0.28);
      g.addColorStop(0, "#ffffff");
      g.addColorStop(0.35, `rgba(90,220,255,${0.75 + 0.25 * k})`);
      g.addColorStop(1, "rgba(40,120,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px + s * 0.5, py + s * 0.5, s * (0.2 + 0.08 * k), 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "crystal": {
      const k = 0.5 + 0.5 * Math.sin(ph * 3);
      ctx.fillStyle = `rgba(230,170,255,${0.12 + 0.2 * k})`;
      ctx.fillRect(px + s * 0.08, py + s * 0.08, s * 0.84, s * 0.84);
      const tw = Math.max(0, Math.sin(ph * 2.3));
      if (tw > 0.6) {
        ctx.strokeStyle = `rgba(255,255,255,${(tw - 0.6) * 2.5})`;
        ctx.lineWidth = Math.max(1, s * 0.04);
        const cx = px + s * 0.62;
        const cy = py + s * 0.3;
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.1, cy); ctx.lineTo(cx + s * 0.1, cy);
        ctx.moveTo(cx, cy - s * 0.1); ctx.lineTo(cx, cy + s * 0.1);
        ctx.stroke();
      }
      break;
    }
    case "atomic": {
      const k = 0.5 + 0.5 * Math.sin(ph * 3.5);
      ctx.strokeStyle = `rgba(120,255,90,${0.35 + 0.45 * k})`;
      ctx.lineWidth = Math.max(1, s * 0.07);
      ctx.beginPath();
      ctx.arc(px + s * 0.5, py + s * 0.5, s * 0.4, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

export function drawGhost(ctx: CanvasRenderingContext2D, px: number, py: number, s: number, value: number, look: Look, t: number): void {
  const color = look.palette[value - 1] ?? "#888888";
  switch (look.ghost) {
    case "off":
      return;
    case "translucent":
      ctx.globalAlpha = 0.24;
      drawBlock(ctx, px, py, s, value, { ...look, glow: "off" }, t);
      ctx.globalAlpha = 1;
      return;
    case "outline":
      ctx.strokeStyle = rgba(color, 0.8);
      ctx.lineWidth = Math.max(1.5, s * 0.08);
      ctx.strokeRect(px + 2, py + 2, s - 4, s - 4);
      return;
    case "dashed":
      ctx.strokeStyle = rgba(color, 0.85);
      ctx.lineWidth = Math.max(1, s * 0.07);
      ctx.setLineDash([Math.max(2, s * 0.18), Math.max(2, s * 0.14)]);
      ctx.strokeRect(px + 2, py + 2, s - 4, s - 4);
      ctx.setLineDash([]);
      return;
    case "glow":
      ctx.fillStyle = rgba(color, 0.13);
      ctx.fillRect(px + 1, py + 1, s - 2, s - 2);
      ctx.shadowColor = color;
      ctx.shadowBlur = s * 0.4;
      ctx.strokeStyle = rgba(color, 0.6);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px + 2, py + 2, s - 4, s - 4);
      ctx.shadowBlur = 0;
      return;
  }
}

// ------------------------------------------------------------------ backgrounds

const bgCache = new Map<string, HTMLCanvasElement>();

function staticBg(kind: Background, w: number, h: number, cell: number): HTMLCanvasElement {
  const key = `${kind}|${w}|${h}|${cell}`;
  let c = bgCache.get(key);
  if (c) return c;
  const dpr = DPR();
  c = makeCanvas(w * dpr, h * dpr);
  const ctx = c.getContext("2d")!;
  ctx.scale(dpr, dpr);
  switch (kind) {
    case "void":
      ctx.fillStyle = "#06070b";
      ctx.fillRect(0, 0, w, h);
      break;
    case "grid":
    case "starfield":
    case "aurora":
      ctx.fillStyle = kind === "aurora" ? "#060a12" : "#0b0d14";
      ctx.fillRect(0, 0, w, h);
      if (kind === "grid" && cell >= 10) {
        ctx.strokeStyle = "rgba(255,255,255,0.045)";
        ctx.lineWidth = 1;
        for (let x = cell; x < w; x += cell) {
          ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); ctx.stroke();
        }
        for (let y = cell; y < h; y += cell) {
          ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); ctx.stroke();
        }
      }
      break;
    case "circuit": {
      ctx.fillStyle = "#07111a";
      ctx.fillRect(0, 0, w, h);
      const r = seeded(7);
      ctx.strokeStyle = "rgba(63,215,232,0.10)";
      ctx.lineWidth = 1;
      for (let i = 0; i < 18; i++) {
        let x = Math.round(r() * 10) * cell;
        let y = Math.round(r() * 20) * cell;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, y + 0.5);
        for (let k = 0; k < 4; k++) {
          if (r() < 0.5) x += (r() < 0.5 ? -1 : 1) * cell * (1 + Math.floor(r() * 3));
          else y += (r() < 0.5 ? -1 : 1) * cell * (1 + Math.floor(r() * 3));
          ctx.lineTo(x + 0.5, y + 0.5);
        }
        ctx.stroke();
        ctx.fillStyle = "rgba(63,215,232,0.18)";
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
      break;
    }
    case "sunset": {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#120b26");
      g.addColorStop(0.55, "#2a1036");
      g.addColorStop(0.8, "#4a1638");
      g.addColorStop(1, "#5a2430");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(255,120,170,0.10)";
      for (let i = 1; i < 8; i++) {
        const y = h * 0.62 + (h * 0.38 * (i * i)) / 64;
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke();
      }
      ctx.fillStyle = "rgba(255,170,90,0.10)";
      ctx.beginPath();
      ctx.arc(w / 2, h * 0.62, w * 0.28, Math.PI, 0);
      ctx.fill();
      break;
    }
    case "nebula": {
      ctx.fillStyle = "#07040f";
      ctx.fillRect(0, 0, w, h);
      const blobs = [
        [0.3, 0.25, 0.55, "rgba(140,60,255,0.28)"],
        [0.75, 0.55, 0.5, "rgba(255,70,170,0.2)"],
        [0.35, 0.8, 0.45, "rgba(60,160,255,0.22)"],
      ] as const;
      for (const [x, y, r, col] of blobs) {
        const g = ctx.createRadialGradient(w * x, h * y, 1, w * x, h * y, w * r);
        g.addColorStop(0, col);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
      break;
    }
    case "embers": {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#0c0505");
      g.addColorStop(0.7, "#2a0b06");
      g.addColorStop(1, "#4a1408");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      break;
    }
    case "matrix":
      ctx.fillStyle = "#020805";
      ctx.fillRect(0, 0, w, h);
      break;
  }
  if (bgCache.size > 40) bgCache.clear();
  bgCache.set(key, c);
  return c;
}

export function drawBackground(ctx: CanvasRenderingContext2D, kind: Background, w: number, h: number, cell: number, t: number, still: boolean): void {
  ctx.drawImage(staticBg(kind, w, h, cell), 0, 0, w, h);
  if (kind === "starfield" || kind === "nebula") {
    const r = seeded(kind === "nebula" ? 77 : 42);
    const n = Math.round((w * h) / (kind === "nebula" ? 1200 : 900));
    for (let i = 0; i < n; i++) {
      const x = r() * w;
      const speed = 0.004 + r() * 0.01;
      const y = (r() * h + (still ? 0 : t * speed * (kind === "nebula" ? 0.4 : 1))) % h;
      const tw = still ? 0.6 : 0.35 + 0.35 * Math.sin(t / 500 + i);
      ctx.fillStyle = `rgba(255,255,255,${tw})`;
      const sz = r() < 0.15 ? 1.6 : 1;
      ctx.fillRect(x, y, sz, sz);
    }
  } else if (kind === "aurora") {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const bands = [
      ["rgba(80,240,180,0.10)", 0.3, 0.0013],
      ["rgba(120,110,255,0.09)", 0.5, 0.0009],
      ["rgba(63,215,232,0.07)", 0.72, 0.0017],
    ] as const;
    for (const [col, yy, sp] of bands) {
      const y = h * yy + Math.sin(still ? 0 : t * sp) * h * 0.06;
      const g = ctx.createLinearGradient(0, y - h * 0.18, 0, y + h * 0.18);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(0.5, col);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, y - h * 0.18, w, h * 0.36);
    }
    ctx.restore();
  } else if (kind === "circuit" && !still) {
    const r = seeded(99);
    for (let i = 0; i < 4; i++) {
      const col = Math.floor(r() * 10);
      const y = (t * (0.03 + r() * 0.03) + r() * h) % h;
      ctx.fillStyle = "rgba(63,215,232,0.35)";
      ctx.fillRect(col * cell + cell / 2 - 1, y, 2, Math.max(4, cell * 0.6));
    }
  } else if (kind === "embers") {
    const r = seeded(5);
    const n = Math.round((w * h) / 1400);
    for (let i = 0; i < n; i++) {
      const x0 = r() * w;
      const sp = 0.012 + r() * 0.02;
      const y = h - ((r() * h + (still ? 0 : t * sp)) % h);
      const x = x0 + (still ? 0 : Math.sin(t / 700 + i) * 4);
      const life = y / h;
      ctx.fillStyle = `rgba(255,${Math.round(120 + 100 * life)},60,${0.25 + 0.5 * life})`;
      ctx.fillRect(x, y, 1.5, 1.5);
    }
  } else if (kind === "matrix") {
    const cols = Math.max(4, Math.floor(w / Math.max(8, cell * 0.7)));
    const cw = w / cols;
    const r = seeded(11);
    ctx.font = `${Math.max(7, cw * 0.85)}px "JetBrains Mono", monospace`;
    ctx.textAlign = "center";
    for (let i = 0; i < cols; i++) {
      const sp = 0.02 + r() * 0.04;
      const len = 6 + Math.floor(r() * 10);
      const head = (r() * h + (still ? 0 : t * sp)) % (h + len * cw);
      for (let k = 0; k < len; k++) {
        const y = head - k * cw;
        if (y < 0 || y > h) continue;
        const a = k === 0 ? 0.7 : 0.35 * (1 - k / len);
        ctx.fillStyle = k === 0 ? `rgba(190,255,200,${a})` : `rgba(40,220,110,${a})`;
        const glyph = (Math.floor(r() * 2) + (still ? 0 : Math.floor(t / 400 + k))) % 2 ? "1" : "0";
        ctx.fillText(glyph, i * cw + cw / 2, y);
      }
    }
  }
}

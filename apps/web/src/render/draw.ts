import { BOARD_HEIGHT, BOARD_WIDTH, PIECE_CELL, SHAPES, VISIBLE_TOP, pieceCells, type Board, type PiecePos, type PieceType } from "@tk/engine";
import { DEFAULT_COSMETICS, type Cosmetics } from "../cosmetics/catalog";
import { drawBackground, drawBlock, drawGhost, type Look } from "./skins";

/**
 * Canvas rendering only. Reads engine state; never mutates it. Skins come in
 * through `look`, which has no path back into the simulation.
 */
export const VISIBLE_ROWS = BOARD_HEIGHT - VISIBLE_TOP;

export const DEFAULT_LOOK: Look = {
  skin: DEFAULT_COSMETICS.block,
  palette: DEFAULT_COSMETICS.palette,
  background: DEFAULT_COSMETICS.background,
  ghost: DEFAULT_COSMETICS.ghost,
  garbage: DEFAULT_COSMETICS.garbage,
};

export const lookOf = (c: Cosmetics): Look => ({
  skin: c.block,
  palette: c.palette,
  background: c.background,
  ghost: c.ghost,
  garbage: c.garbage,
  corners: c.corners,
  gap: c.gap,
  pattern: c.pattern,
  glow: c.glow,
});

export interface RowFlash {
  /** Visible row index (0 = top of the visible matrix). */
  row: number;
  /** performance.now() when the clear happened. */
  at: number;
}

export interface BoardDrawOptions {
  board: Board;
  size: number;
  look?: Look;
  active?: PiecePos | null;
  ghostY?: number | null;
  dim?: boolean;
  label?: string;
  /** Clock for animated skins/backgrounds (ms). */
  time?: number;
  flashes?: RowFlash[];
  /** Freeze animated backgrounds (reduce-motion, or small opponent boards). */
  still?: boolean;
  reduceFlashing?: boolean;
  /** 0..1: how close the stack is to the top, for the danger glow. */
  danger?: number;
}

export const FLASH_MS = 220;

export function sizeCanvas(canvas: HTMLCanvasElement, cols: number, rows: number, size: number): CanvasRenderingContext2D {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cols * size;
  const h = rows * size;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  return ctx;
}

/** Highest occupied visible row as 0 (empty) .. 1 (at the top). */
export function stackDanger(board: Board): number {
  for (let y = VISIBLE_TOP - 2; y < BOARD_HEIGHT; y++) {
    for (let x = 0; x < BOARD_WIDTH; x++) if (board[y * BOARD_WIDTH + x]) return Math.max(0, Math.min(1, (BOARD_HEIGHT - y) / VISIBLE_ROWS));
  }
  return 0;
}

export function drawBoard(canvas: HTMLCanvasElement, o: BoardDrawOptions): void {
  const look = o.look ?? DEFAULT_LOOK;
  const s = o.size;
  const t = o.time ?? performance.now();
  const W = BOARD_WIDTH * s;
  const H = VISIBLE_ROWS * s;
  const ctx = sizeCanvas(canvas, BOARD_WIDTH, VISIBLE_ROWS, s);
  drawBackground(ctx, look.background, W, H, s, t, !!o.still);

  if (o.danger && o.danger > 0.7) {
    const a = (o.danger - 0.7) / 0.3;
    const g = ctx.createLinearGradient(0, 0, 0, H * 0.4);
    g.addColorStop(0, `rgba(240,90,90,${0.28 * a})`);
    g.addColorStop(1, "rgba(240,90,90,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H * 0.4);
  }

  for (let y = VISIBLE_TOP; y < BOARD_HEIGHT; y++) {
    for (let x = 0; x < BOARD_WIDTH; x++) {
      const v = o.board[y * BOARD_WIDTH + x]!;
      if (v) drawBlock(ctx, x * s, (y - VISIBLE_TOP) * s, s, v, look, t, x, y);
    }
  }

  if (o.active) {
    const v = PIECE_CELL[o.active.type];
    if (o.ghostY !== null && o.ghostY !== undefined && o.ghostY !== o.active.y) {
      for (const [x, y] of pieceCells({ ...o.active, y: o.ghostY })) if (y >= VISIBLE_TOP) drawGhost(ctx, x * s, (y - VISIBLE_TOP) * s, s, v, look, t);
    }
    for (const [x, y] of pieceCells(o.active)) if (y >= VISIBLE_TOP) drawBlock(ctx, x * s, (y - VISIBLE_TOP) * s, s, v, look, t);
  }

  if (o.flashes?.length) {
    for (const f of o.flashes) {
      const age = (t - f.at) / FLASH_MS;
      if (age < 0 || age > 1) continue;
      const a = (1 - age) * (o.reduceFlashing ? 0.3 : 0.85);
      const grow = 0.35 + 0.65 * Math.min(1, age * 2.5);
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.fillRect((W * (1 - grow)) / 2, f.row * s, W * grow, s);
    }
  }

  if (o.dim) {
    ctx.fillStyle = "rgba(8,9,14,0.55)";
    ctx.fillRect(0, 0, W, H);
  }
  if (o.label) {
    ctx.fillStyle = "#fff";
    ctx.font = `700 ${Math.max(10, s * 1.1)}px "Space Grotesk", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(o.label, W / 2, H / 2);
  }
}

export function drawPieceList(canvas: HTMLCanvasElement, pieces: (PieceType | null)[], size: number, look: Look = DEFAULT_LOOK, faded = false): void {
  const rows = pieces.length * 3;
  const ctx = sizeCanvas(canvas, 4, rows, size);
  ctx.clearRect(0, 0, 4 * size, rows * size);
  const t = performance.now();
  if (faded) ctx.globalAlpha = 0.35;
  pieces.forEach((type, i) => {
    if (!type) return;
    const cells = SHAPES[type][0]!;
    const minX = Math.min(...cells.map((c) => c[0]));
    const maxX = Math.max(...cells.map((c) => c[0]));
    const minY = Math.min(...cells.map((c) => c[1]));
    const offX = (4 - (maxX - minX + 1)) / 2 - minX;
    for (const [cx, cy] of cells) drawBlock(ctx, (cx + offX) * size, (i * 3 + 0.5 + (cy - minY)) * size, size, PIECE_CELL[type], look, t);
  });
  ctx.globalAlpha = 1;
}

/** Rows (in visible coordinates) a placement would clear, computed BEFORE it is applied. */
export function rowsClearedBy(board: Board, piece: PiecePos): number[] {
  const b = board.slice();
  for (const [x, y] of pieceCells(piece)) if (y >= 0 && y < BOARD_HEIGHT) b[y * BOARD_WIDTH + x] = 1;
  const rows: number[] = [];
  for (let y = 0; y < BOARD_HEIGHT; y++) {
    let full = true;
    for (let x = 0; x < BOARD_WIDTH; x++) if (!b[y * BOARD_WIDTH + x]) { full = false; break; }
    if (full) rows.push(y - VISIBLE_TOP);
  }
  return rows;
}

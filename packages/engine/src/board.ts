import { BOMB_CELL, GARBAGE_CELL, PIECE_CELL, SHAPES, kicksFor, type PieceType, type Rotation } from "./pieces.js";

export const BOARD_WIDTH = 10;
/** 20 visible rows plus a 20-row buffer above the skyline. */
export const BOARD_HEIGHT = 40;
export const VISIBLE_TOP = 20;
export const SPAWN_X = 3;
export const SPAWN_Y = 18;

export type Board = Uint8Array;

export interface PiecePos {
  type: PieceType;
  x: number;
  y: number;
  rot: Rotation;
}

export function createBoard(): Board {
  return new Uint8Array(BOARD_WIDTH * BOARD_HEIGHT);
}

export function cellAt(board: Board, x: number, y: number): number {
  return board[y * BOARD_WIDTH + x] ?? 0;
}

/** Out of bounds counts as occupied; above the matrix (y<0) counts as occupied too. */
export function isBlocked(board: Board, x: number, y: number): boolean {
  if (x < 0 || x >= BOARD_WIDTH || y < 0 || y >= BOARD_HEIGHT) return true;
  return board[y * BOARD_WIDTH + x] !== 0;
}

export function pieceCells(p: PiecePos): [number, number][] {
  return SHAPES[p.type][p.rot]!.map(([cx, cy]) => [p.x + cx, p.y + cy]);
}

export function collides(board: Board, p: PiecePos): boolean {
  for (const [x, y] of pieceCells(p)) if (isBlocked(board, x, y)) return true;
  return false;
}

export function isGrounded(board: Board, p: PiecePos): boolean {
  return collides(board, { ...p, y: p.y + 1 });
}

export function spawnPos(type: PieceType): PiecePos {
  return { type, x: SPAWN_X, y: SPAWN_Y, rot: 0 };
}

export interface RotateResult {
  pos: PiecePos;
  kickIndex: number;
}

export function tryRotate(board: Board, p: PiecePos, dir: 1 | -1): RotateResult | null {
  const to = (((p.rot + dir) % 4) + 4) % 4 as Rotation;
  const kicks = kicksFor(p.type, p.rot, to);
  for (let i = 0; i < kicks.length; i++) {
    const [dx, dy] = kicks[i]!;
    const cand: PiecePos = { type: p.type, x: p.x + dx, y: p.y + dy, rot: to };
    if (!collides(board, cand)) return { pos: cand, kickIndex: i };
  }
  return null;
}

export function hardDropY(board: Board, p: PiecePos): number {
  let y = p.y;
  while (!collides(board, { ...p, y: y + 1 })) y++;
  return y;
}

export function writePiece(board: Board, p: PiecePos): void {
  const v = PIECE_CELL[p.type];
  for (const [x, y] of pieceCells(p)) board[y * BOARD_WIDTH + x] = v;
}

/** Removes full rows, returns the number of rows cleared. */
export function clearLines(board: Board): number {
  let cleared = 0;
  for (let y = BOARD_HEIGHT - 1; y >= 0; y--) {
    let full = true;
    for (let x = 0; x < BOARD_WIDTH; x++) {
      if (board[y * BOARD_WIDTH + x] === 0) {
        full = false;
        break;
      }
    }
    if (full) {
      board.copyWithin(BOARD_WIDTH, 0, y * BOARD_WIDTH);
      board.fill(0, 0, BOARD_WIDTH);
      cleared++;
      y++; // re-check the same row index, now holding the row above
    }
  }
  return cleared;
}

export function isEmpty(board: Board): boolean {
  for (let i = 0; i < board.length; i++) if (board[i] !== 0) return false;
  return true;
}

/**
 * Pushes `lines` garbage rows in from the bottom with a single hole column.
 * Rows listed in `bombRows` (0 = the topmost new row) get a bomb at `bombCol`.
 * Returns true if any block was pushed off the top of the matrix (top-out).
 */
export function insertGarbage(board: Board, lines: number, holeCol: number, bombCol = -1, bombRows: readonly number[] = []): boolean {
  if (lines <= 0) return false;
  const n = Math.min(lines, BOARD_HEIGHT);
  let overflow = false;
  for (let i = 0; i < n * BOARD_WIDTH; i++) if (board[i] !== 0) overflow = true;
  board.copyWithin(0, n * BOARD_WIDTH);
  for (let y = BOARD_HEIGHT - n; y < BOARD_HEIGHT; y++) {
    const bomb = bombCol >= 0 && bombRows.includes(y - (BOARD_HEIGHT - n)) ? bombCol : -1;
    for (let x = 0; x < BOARD_WIDTH; x++) board[y * BOARD_WIDTH + x] = x === holeCol ? 0 : x === bomb ? BOMB_CELL : GARBAGE_CELL;
  }
  return overflow;
}

/**
 * What a bomb destroys when its row is cleared:
 * - `line`: the whole row beneath it, as if that row were cleared too.
 * - `area`: the 8 cells around it.
 * - `column`: every cell below it, down to the floor.
 * Any bomb caught in a blast detonates as well (chain reaction).
 */
export type BombBlast = "line" | "area" | "column";
export const BOMB_BLASTS: readonly BombBlast[] = ["line", "area", "column"];

export interface ClearOutcome {
  /** Rows the player completed (drives the attack/score tables). */
  lines: number;
  /** Extra rows removed by `line` blasts. */
  blastedRows: number;
  /** Bombs that went off, in board coordinates before anything moved. */
  detonations: [x: number, y: number][];
  /** Every row index removed (completed + blasted), before anything moved. */
  removedRows: number[];
}

/**
 * Line clear with bomb detonation. Full rows are found first; bombs inside
 * them detonate (chaining), then blasted cells are emptied and all removed
 * rows collapse. Without bombs on the board this is identical to clearLines.
 */
export function clearLinesWithBombs(board: Board, blast: BombBlast): ClearOutcome {
  const W = BOARD_WIDTH;
  const removed = new Set<number>();
  for (let y = 0; y < BOARD_HEIGHT; y++) {
    let full = true;
    for (let x = 0; x < W; x++) if (board[y * W + x] === 0) { full = false; break; }
    if (full) removed.add(y);
  }
  const lines = removed.size;
  const queue: [number, number][] = [];
  const seen = new Set<number>();
  const arm = (x: number, y: number) => {
    const i = y * W + x;
    if (board[i] === BOMB_CELL && !seen.has(i)) {
      seen.add(i);
      queue.push([x, y]);
    }
  };
  for (const y of removed) for (let x = 0; x < W; x++) arm(x, y);

  const wiped = new Set<number>();
  const detonations: [number, number][] = [];
  let blastedRows = 0;
  while (queue.length > 0) {
    const [bx, by] = queue.shift()!;
    detonations.push([bx, by]);
    if (blast === "line") {
      const y = by + 1;
      if (y < BOARD_HEIGHT && !removed.has(y)) {
        removed.add(y);
        blastedRows++;
        for (let x = 0; x < W; x++) arm(x, y);
      }
    } else {
      const cells: [number, number][] = [];
      if (blast === "area") {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) cells.push([bx + dx, by + dy]);
      } else {
        for (let y = by + 1; y < BOARD_HEIGHT; y++) cells.push([bx, y]);
      }
      for (const [x, y] of cells) {
        if (x < 0 || x >= W || y < 0 || y >= BOARD_HEIGHT) continue;
        arm(x, y);
        wiped.add(y * W + x);
      }
    }
  }
  for (const i of wiped) board[i] = 0;
  const removedRows = [...removed].sort((a, b) => a - b);
  if (removedRows.length > 0) {
    // Compact: copy surviving rows downward, bottom first.
    let dst = BOARD_HEIGHT - 1;
    for (let y = BOARD_HEIGHT - 1; y >= 0; y--) {
      if (removed.has(y)) continue;
      if (dst !== y) board.copyWithin(dst * W, y * W, y * W + W);
      dst--;
    }
    board.fill(0, 0, (dst + 1) * W);
  }
  return { lines, blastedRows, detonations, removedRows };
}

export function boardToString(board: Board): string {
  let s = "";
  for (let i = 0; i < board.length; i++) s += board[i]!.toString(16);
  return s;
}

export function boardFromString(s: string): Board {
  if (s.length !== BOARD_WIDTH * BOARD_HEIGHT || !/^[0-9]+$/.test(s)) throw new Error("invalid board string");
  const b = createBoard();
  for (let i = 0; i < s.length; i++) b[i] = parseInt(s[i]!, 16);
  return b;
}

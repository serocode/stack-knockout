import { GARBAGE_CELL, PIECE_CELL, SHAPES, kicksFor, type PieceType, type Rotation } from "./pieces.js";

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
 * Returns true if any block was pushed off the top of the matrix (top-out).
 */
export function insertGarbage(board: Board, lines: number, holeCol: number): boolean {
  if (lines <= 0) return false;
  const n = Math.min(lines, BOARD_HEIGHT);
  let overflow = false;
  for (let i = 0; i < n * BOARD_WIDTH; i++) if (board[i] !== 0) overflow = true;
  board.copyWithin(0, n * BOARD_WIDTH);
  for (let y = BOARD_HEIGHT - n; y < BOARD_HEIGHT; y++) {
    for (let x = 0; x < BOARD_WIDTH; x++) board[y * BOARD_WIDTH + x] = x === holeCol ? 0 : GARBAGE_CELL;
  }
  return overflow;
}

export function boardToString(board: Board): string {
  let s = "";
  for (let i = 0; i < board.length; i++) s += board[i]!.toString(16);
  return s;
}

export function boardFromString(s: string): Board {
  if (s.length !== BOARD_WIDTH * BOARD_HEIGHT || !/^[0-8]+$/.test(s)) throw new Error("invalid board string");
  const b = createBoard();
  for (let i = 0; i < s.length; i++) b[i] = parseInt(s[i]!, 16);
  return b;
}

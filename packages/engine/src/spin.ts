import { isBlocked, type Board, type PiecePos } from "./board.js";
import type { TSpinKind } from "./attack.js";

/** Corners of the T box, relative to box origin, in order: TL, TR, BL, BR. */
const CORNERS = [
  [0, 0],
  [2, 0],
  [0, 2],
  [2, 2],
] as const;

/** Indices into CORNERS for the two "front" corners (the side the T points to). */
const FRONT: Record<number, readonly [number, number]> = {
  0: [0, 1], // pointing up
  1: [1, 3], // pointing right
  2: [2, 3], // pointing down
  3: [0, 2], // pointing left
};

/**
 * Guideline 3-corner T-spin detection. Must be called with the board BEFORE the
 * piece is written, after the final position is known.
 */
export function detectTSpin(board: Board, p: PiecePos, lastMoveRotate: boolean, kickIndex: number): TSpinKind {
  if (p.type !== "T" || !lastMoveRotate) return "none";
  const occ = CORNERS.map(([cx, cy]) => isBlocked(board, p.x + cx, p.y + cy));
  const count = occ.filter(Boolean).length;
  if (count < 3) return "none";
  const [f1, f2] = FRONT[p.rot]!;
  if (occ[f1] && occ[f2]) return "full";
  // The fifth SRS test (index 4) upgrades a mini to a full T-spin (TST / fin kicks).
  if (kickIndex === 4) return "full";
  return "mini";
}

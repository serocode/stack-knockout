import { collides, spawnPos, tryRotate, type Board, type PiecePos } from "./board.js";
import type { PieceType, Rotation } from "./pieces.js";

/**
 * Breadth-first reachability over (x, y, rotation) from the spawn position using
 * left/right/down moves and SRS rotations. Used by the host to verify that a
 * reported placement is physically reachable and that a claimed rotation-into-
 * final-position (needed for T-spins) really exists with the claimed kick.
 */
export interface ReachInfo {
  reachable: boolean;
  /** Bitmask of SRS kick indices by which the target was entered via rotation. */
  rotationKicks: number;
}

const X_OFF = 4;
const Y_OFF = 4;
const XS = 18;
const YS = 48;
const key = (x: number, y: number, r: number) => (r * YS + (y + Y_OFF)) * XS + (x + X_OFF);

export function analyzeReach(board: Board, type: PieceType, target: { x: number; y: number; rot: Rotation }): ReachInfo {
  const start = spawnPos(type);
  if (collides(board, start)) return { reachable: false, rotationKicks: 0 };
  const seen = new Uint8Array(4 * YS * XS);
  const targetKey = key(target.x, target.y, target.rot);
  let rotationKicks = 0;
  const queue: PiecePos[] = [start];
  seen[key(start.x, start.y, start.rot)] = 1;
  let head = 0;
  const visit = (p: PiecePos) => {
    const k = key(p.x, p.y, p.rot);
    if (k < 0 || k >= seen.length || seen[k]) return;
    seen[k] = 1;
    queue.push(p);
  };
  while (head < queue.length) {
    const p = queue[head++]!;
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, 1],
    ] as const) {
      const n: PiecePos = { ...p, x: p.x + dx, y: p.y + dy };
      if (!collides(board, n)) visit(n);
    }
    for (const dir of [1, -1] as const) {
      const r = tryRotate(board, p, dir);
      if (!r) continue;
      if (key(r.pos.x, r.pos.y, r.pos.rot) === targetKey) rotationKicks |= 1 << r.kickIndex;
      visit(r.pos);
    }
  }
  return { reachable: seen[targetKey] === 1, rotationKicks };
}

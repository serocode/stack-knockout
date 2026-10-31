import { BOARD_HEIGHT, BOARD_WIDTH, collides, hardDropY, isBlocked, spawnPos, tryRotate, writePiece, clearLines, type PiecePos } from "./board.js";
import type { Rotation } from "./pieces.js";
import type { PlayerSim, Placement } from "./player-sim.js";
import { rngNext, type RngState } from "./rng.js";

/**
 * A small heuristic bot used by tests and the migration lab. It only produces
 * placements that a human could reach (rotate at spawn, shift, hard drop).
 */
export function botPlacement(sim: PlayerSim, rng: RngState, skill = 1): { placement: Placement | null; rng: RngState } {
  const board = sim.s.board;
  let best: { pos: PiecePos; usedHold: boolean; score: number } | null = null;
  for (const usedHold of [false, true]) {
    const type = usedHold ? sim.holdSwapType() : sim.s.active;
    if (usedHold && type === sim.s.active) continue;
    for (let r = 0 as Rotation; r < 4; r = (r + 1) as Rotation) {
      let base: PiecePos | null = spawnPos(type);
      if (collides(board, base)) continue;
      for (let i = 0; i < r && base; i++) base = tryRotate(board, base, 1)?.pos ?? null;
      if (!base) continue;
      for (let dx = -5; dx <= 5; dx++) {
        // shift step by step so the path is genuinely reachable
        let p: PiecePos = base;
        let ok = true;
        const step = dx < 0 ? -1 : 1;
        for (let k = 0; k !== dx; k += step) {
          const n = { ...p, x: p.x + step };
          if (collides(board, n)) {
            ok = false;
            break;
          }
          p = n;
        }
        if (!ok) continue;
        const final = { ...p, y: hardDropY(board, p) };
        const s = evaluate(board, final);
        if (!best || s > best.score) best = { pos: final, usedHold, score: s };
      }
    }
  }
  let next = rng;
  if (!best) return { placement: null, rng: next };
  // Lower skill: sometimes pick a random column instead of the best one.
  const [roll, n2] = rngNext(next);
  next = n2;
  if (roll > skill) {
    const type = sim.s.active;
    const p = spawnPos(type);
    if (!collides(board, p)) best = { pos: { ...p, y: hardDropY(board, p) }, usedHold: false, score: 0 };
  }
  return {
    placement: {
      pieceIndex: sim.s.piecesPlaced,
      type: best.pos.type,
      usedHold: best.usedHold,
      x: best.pos.x,
      y: best.pos.y,
      rot: best.pos.rot,
      lastMoveRotate: false,
      kickIndex: -1,
      garbageIds: [],
    },
    rng: next,
  };
}

function evaluate(board: Uint8Array, p: PiecePos): number {
  const b = board.slice();
  writePiece(b, p);
  const lines = clearLines(b);
  let aggregate = 0;
  let holes = 0;
  let bump = 0;
  let prev = -1;
  for (let x = 0; x < BOARD_WIDTH; x++) {
    let h = 0;
    for (let y = 0; y < BOARD_HEIGHT; y++) {
      if (isBlocked(b, x, y)) {
        h = BOARD_HEIGHT - y;
        for (let yy = y + 1; yy < BOARD_HEIGHT; yy++) if (!isBlocked(b, x, yy)) holes++;
        break;
      }
    }
    aggregate += h;
    if (prev >= 0) bump += Math.abs(h - prev);
    prev = h;
  }
  return lines * 0.76 - aggregate * 0.51 - holes * 0.36 - bump * 0.18;
}

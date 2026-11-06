import { bagDraw, bagPeek, cloneBag, createBag, type BagState } from "./bag.js";
import {
  BOARD_WIDTH,
  VISIBLE_TOP,
  boardFromString,
  boardToString,
  clearLinesWithBombs,
  collides,
  createBoard,
  insertGarbage,
  isEmpty,
  isGrounded,
  pieceCells,
  spawnPos,
  writePiece,
  BOMB_BLASTS,
  type Board,
  type BombBlast,
  type PiecePos,
} from "./board.js";
import { computeAttack, computeScore, isDifficult, type TSpinKind } from "./attack.js";
import { isPieceType, type PieceType, type Rotation } from "./pieces.js";
import { analyzeReach } from "./reach.js";
import { hashBytes, hashString } from "./rng.js";
import { detectTSpin } from "./spin.js";

/** A garbage chunk the host has ordered this player to absorb. */
export interface GarbageChunk {
  id: string;
  lines: number;
  holeCol: number;
  /** Column holding this chunk's bombs (absent or -1 = no bombs). */
  bombCol?: number;
  /** Rows of this chunk carrying a bomb, 0 = the topmost row. */
  bombRows?: number[];
}

/** Match-wide bomb behaviour. Fixed when the match starts. */
export interface BombSettings {
  blast: BombBlast;
  /** Extra attack lines per bomb detonated. */
  bonus: number;
}

export const DEFAULT_BOMB_SETTINGS: BombSettings = { blast: "line", bonus: 1 };
export const MAX_BOMB_BONUS = 3;

function validBombChunk(g: GarbageChunk): boolean {
  if (g.bombCol === undefined || g.bombCol === -1) return g.bombRows === undefined || g.bombRows.length === 0;
  if (!Number.isInteger(g.bombCol) || g.bombCol < 0 || g.bombCol >= BOARD_WIDTH || g.bombCol === g.holeCol) return false;
  return Array.isArray(g.bombRows) && g.bombRows.length <= g.lines && g.bombRows.every((r) => Number.isInteger(r) && r >= 0 && r < g.lines);
}

export function sanitizeBombSettings(v: unknown): BombSettings {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const blast = BOMB_BLASTS.includes(o.blast as BombBlast) ? (o.blast as BombBlast) : DEFAULT_BOMB_SETTINGS.blast;
  const bonus = Number.isInteger(o.bonus) && (o.bonus as number) >= 0 && (o.bonus as number) <= MAX_BOMB_BONUS ? (o.bonus as number) : DEFAULT_BOMB_SETTINGS.bonus;
  return { blast, bonus };
}

/**
 * Everything needed to replay one piece lock. Players send this; the host
 * replays it on a shadow sim with the same code to validate it.
 */
export interface Placement {
  /** Index of this piece (0-based); must equal the sim's piecesPlaced. */
  pieceIndex: number;
  type: PieceType;
  usedHold: boolean;
  x: number;
  y: number;
  rot: Rotation;
  lastMoveRotate: boolean;
  /** SRS kick index of the last rotation (-1 if the last move was not a rotation). */
  kickIndex: number;
  /** Garbage chunk ids inserted at this lock, in order. */
  garbageIds: string[];
}

export type TopOutReason = "block-out" | "lock-out" | "garbage" | "forfeit";

export interface LockResult {
  lines: number;
  tspin: TSpinKind;
  perfectClear: boolean;
  combo: number;
  b2bBonus: boolean;
  attack: number;
  score: number;
  toppedOut: boolean;
  topOutReason: TopOutReason | null;
  /** Bombs detonated by this lock (0 when bombs are off). */
  bombs: number;
  /** Extra rows removed by line blasts. */
  blastedRows: number;
  /** Where each bomb went off, board coordinates before the clear. */
  detonations: [x: number, y: number][];
  /** Every row removed by this lock (completed + blasted), board coordinates before the clear. */
  removedRows: number[];
}

export type PlacementError =
  | "topped-out"
  | "wrong-index"
  | "wrong-piece"
  | "collision"
  | "not-grounded"
  | "unreachable"
  | "invalid-spin"
  | "bad-garbage";

export type PlacementOutcome = { ok: true; result: LockResult } | { ok: false; error: PlacementError };

export interface PlayerSimState {
  board: Board;
  bag: BagState;
  active: PieceType;
  hold: PieceType | null;
  piecesPlaced: number;
  combo: number;
  b2bChain: number;
  score: number;
  lines: number;
  toppedOut: boolean;
  topOutReason: TopOutReason | null;
  bombs: BombSettings;
}

export interface SerializedPlayerSim {
  board: string;
  bag: { rng: number; queue: PieceType[] };
  active: PieceType;
  hold: PieceType | null;
  piecesPlaced: number;
  combo: number;
  b2bChain: number;
  score: number;
  lines: number;
  toppedOut: boolean;
  topOutReason: TopOutReason | null;
  /** Absent in states from older clients (= defaults). */
  bombs?: BombSettings;
}

/**
 * Deterministic per-player simulation. The local client and the host's shadow
 * copy run identical code, so identical inputs give identical state hashes.
 */
export class PlayerSim {
  readonly s: PlayerSimState;

  private constructor(state: PlayerSimState) {
    this.s = state;
  }

  static create(seed: number, bombs: BombSettings = DEFAULT_BOMB_SETTINGS): PlayerSim {
    const bag = createBag(seed);
    const active = bagDraw(bag);
    return new PlayerSim({
      board: createBoard(),
      bag,
      active,
      hold: null,
      piecesPlaced: 0,
      combo: -1,
      b2bChain: 0,
      score: 0,
      lines: 0,
      toppedOut: false,
      topOutReason: null,
      bombs: { ...bombs },
    });
  }

  /** Upcoming pieces after the active one. */
  preview(count: number): PieceType[] {
    return bagPeek(this.s.bag, count);
  }

  /** Piece type the player would control after pressing hold now. */
  holdSwapType(): PieceType {
    return this.s.hold ?? bagPeek(this.s.bag, 1)[0]!;
  }

  forfeit(): void {
    this.s.toppedOut = true;
    this.s.topOutReason = "forfeit";
  }

  applyPlacement(p: Placement, garbage: readonly GarbageChunk[]): PlacementOutcome {
    const s = this.s;
    if (s.toppedOut) return { ok: false, error: "topped-out" };
    if (p.pieceIndex !== s.piecesPlaced) return { ok: false, error: "wrong-index" };
    if (garbage.length !== p.garbageIds.length || garbage.some((g, i) => g.id !== p.garbageIds[i]))
      return { ok: false, error: "bad-garbage" };
    for (const g of garbage) {
      if (!Number.isInteger(g.lines) || g.lines < 0 || g.lines > 40) return { ok: false, error: "bad-garbage" };
      if (!Number.isInteger(g.holeCol) || g.holeCol < 0 || g.holeCol >= BOARD_WIDTH) return { ok: false, error: "bad-garbage" };
      if (!validBombChunk(g)) return { ok: false, error: "bad-garbage" };
    }

    // Work out which piece is being placed and what ends up in hold.
    const bag = cloneBag(s.bag);
    let placedType: PieceType;
    let newHold: PieceType | null;
    if (!p.usedHold) {
      placedType = s.active;
      newHold = s.hold;
    } else if (s.hold === null) {
      newHold = s.active;
      placedType = bagDraw(bag);
    } else {
      placedType = s.hold;
      newHold = s.active;
    }
    if (p.type !== placedType) return { ok: false, error: "wrong-piece" };

    const pos: PiecePos = { type: placedType, x: p.x, y: p.y, rot: p.rot };
    if (collides(s.board, pos)) return { ok: false, error: "collision" };
    if (!isGrounded(s.board, pos)) return { ok: false, error: "not-grounded" };
    const reach = analyzeReach(s.board, placedType, pos);
    if (!reach.reachable) return { ok: false, error: "unreachable" };
    if (p.lastMoveRotate) {
      if (p.kickIndex < 0 || p.kickIndex > 4 || (reach.rotationKicks & (1 << p.kickIndex)) === 0)
        return { ok: false, error: "invalid-spin" };
    }

    // --- Validated: commit. ---
    const tspin = detectTSpin(s.board, pos, p.lastMoveRotate, p.kickIndex);
    const cells = pieceCells(pos);
    writePiece(s.board, pos);
    const clear = clearLinesWithBombs(s.board, s.bombs.blast);
    const lines = clear.lines;
    const bombs = clear.detonations.length;
    const perfectClear = lines > 0 && isEmpty(s.board);

    const combo = lines > 0 ? s.combo + 1 : -1;
    const difficult = isDifficult(lines, tspin);
    const b2bBonus = lines > 0 && difficult && s.b2bChain > 0;
    if (lines > 0) s.b2bChain = difficult ? s.b2bChain + 1 : 0;
    const info = { lines, tspin, perfectClear, combo, b2bBonus };
    const attack = computeAttack(info) + bombs * s.bombs.bonus;
    const score = computeScore(info) + bombs * 100;

    s.combo = combo;
    s.score += score;
    s.lines += lines;
    s.bag = bag;
    s.hold = newHold;
    s.piecesPlaced++;

    let topOutReason: TopOutReason | null = null;
    if (lines === 0 && cells.every(([, y]) => y < VISIBLE_TOP)) topOutReason = "lock-out";

    for (const g of garbage) {
      if (insertGarbage(s.board, g.lines, g.holeCol, g.bombCol ?? -1, g.bombRows ?? [])) topOutReason ??= "garbage";
    }

    s.active = bagDraw(s.bag);
    if (topOutReason === null && collides(s.board, spawnPos(s.active))) topOutReason = "block-out";
    if (topOutReason) {
      s.toppedOut = true;
      s.topOutReason = topOutReason;
    }
    return {
      ok: true,
      result: {
        lines,
        tspin,
        perfectClear,
        combo,
        b2bBonus,
        attack,
        score,
        toppedOut: s.toppedOut,
        topOutReason,
        bombs,
        blastedRows: clear.blastedRows,
        detonations: clear.detonations,
        removedRows: clear.removedRows,
      },
    };
  }

  hash(): number {
    const s = this.s;
    const meta = [s.active, s.hold ?? "-", s.piecesPlaced, s.combo, s.b2bChain, s.score, s.lines, s.bag.rng, s.bag.queue.join(""), s.toppedOut ? 1 : 0].join("|");
    return hashString(meta, hashBytes(s.board));
  }

  serialize(): SerializedPlayerSim {
    const s = this.s;
    return {
      board: boardToString(s.board),
      bag: { rng: s.bag.rng, queue: [...s.bag.queue] },
      active: s.active,
      hold: s.hold,
      piecesPlaced: s.piecesPlaced,
      combo: s.combo,
      b2bChain: s.b2bChain,
      score: s.score,
      lines: s.lines,
      toppedOut: s.toppedOut,
      topOutReason: s.topOutReason,
      bombs: { ...s.bombs },
    };
  }

  static deserialize(d: SerializedPlayerSim): PlayerSim {
    if (!isPieceType(d.active) || (d.hold !== null && !isPieceType(d.hold)) || !d.bag.queue.every(isPieceType))
      throw new Error("invalid serialized sim");
    return new PlayerSim({
      board: boardFromString(d.board),
      bag: { rng: d.bag.rng >>> 0, queue: [...d.bag.queue] },
      active: d.active,
      hold: d.hold,
      piecesPlaced: d.piecesPlaced,
      combo: d.combo,
      b2bChain: d.b2bChain,
      score: d.score,
      lines: d.lines,
      toppedOut: d.toppedOut,
      topOutReason: d.topOutReason,
      bombs: sanitizeBombSettings(d.bombs),
    });
  }

  clone(): PlayerSim {
    return PlayerSim.deserialize(this.serialize());
  }
}

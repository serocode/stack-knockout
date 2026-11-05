import {
  analyzeReach,
  botPlacement,
  collides,
  hardDropY,
  hashString,
  spawnPos,
  tryRotate,
  type LiveController,
  type Placement,
  type PiecePos,
  type PieceType,
  type PlayerSim,
  type Rotation,
} from "@tk/engine";

/**
 * Coaching and callouts (presentation side). Suggestions and callouts are
 * advisory only: the coordinator carries them on the droppable viz channel and
 * nothing here can change the simulation except by issuing the same commands
 * the player's own keys would.
 */

export interface Callout {
  code: string;
  emoji: string;
  /** Wording; `about` is the named player's display name when the callout names one. */
  text: (about: string | null) => string;
  hint: string;
}

export const CALLOUTS: readonly Callout[] = [
  { code: "nice", emoji: "👏", text: () => "Nice!", hint: "Cheer someone on" },
  { code: "focus", emoji: "🎯", text: (a) => (a ? `Everyone focus ${a}!` : "Focus fire!"), hint: "Rally attacks on a player" },
  { code: "help", emoji: "🆘", text: () => "Help, I'm under fire!", hint: "Ask for backup" },
  { code: "heads", emoji: "⚠️", text: () => "Heads up, big attack incoming", hint: "Warn the room" },
  { code: "tspin", emoji: "🌀", text: () => "Set up a T-spin!", hint: "Coaching tip" },
  { code: "gg", emoji: "🤝", text: () => "GG", hint: "Good game" },
];

export const calloutOf = (code: string) => CALLOUTS.find((c) => c.code === code) ?? null;

/** Stable, distinct colour per coach so several suggestions on one board stay readable. */
export function coachColor(pid: string): string {
  return `hsl(${hashString(pid) % 360} 90% 66%)`;
}

/** Where a piece lands if dropped straight down from (x, rot), or null if it can't be there. */
export function dropAt(board: Uint8Array, type: PieceType, x: number, rot: Rotation): PiecePos | null {
  // Start high enough that rotation offsets never clip the top of the matrix.
  const top: PiecePos = { type, x, y: spawnPos(type).y, rot };
  if (collides(board, top)) return null;
  return { ...top, y: hardDropY(board, top) };
}

/** Can a player actually get their piece into this spot (SRS moves from spawn)? */
export function reachable(board: Uint8Array, p: PiecePos): boolean {
  return analyzeReach(board, p.type, { x: p.x, y: p.y, rot: p.rot }).reachable;
}

/** The built-in bot's pick, as a starting point for a coach. */
export function bestSuggestion(sim: PlayerSim): { usedHold: boolean; piece: PiecePos } | null {
  const r = botPlacement(sim, 1, 1).placement;
  return r ? { usedHold: r.usedHold, piece: { type: r.type, x: r.x, y: r.y, rot: r.rot } } : null;
}

/**
 * Drive the live controller to a suggested hard-drop spot using the same
 * commands as the keyboard: hold (if asked), rotate, shift, hard drop.
 * Returns the resulting Placement, or null (leaving the piece wherever the
 * attempt got it) if the spot can't be reached that way.
 */
export function steerTo(c: LiveController, target: { usedHold: boolean; piece: PiecePos }, board: Uint8Array): Placement | null {
  if (target.usedHold && !c.holdUsed) c.command("hold");
  if (c.piece.type !== target.piece.type) return null;
  const turns = (target.piece.rot - c.piece.rot + 4) % 4;
  const cmds = turns === 3 ? ["ccw"] : Array.from({ length: turns }, () => "cw");
  for (const cmd of cmds) {
    if (!tryRotate(board, c.piece, cmd === "cw" ? 1 : -1)) return null;
    c.command(cmd as "cw" | "ccw");
  }
  for (let guard = 0; guard < 12 && c.piece.x !== target.piece.x; guard++) {
    const before = c.piece.x;
    c.command(c.piece.x < target.piece.x ? "right" : "left");
    if (c.piece.x === before) return null;
  }
  if (c.piece.rot !== target.piece.rot || c.ghostY() !== target.piece.y) return null;
  return c.command("hardDrop");
}

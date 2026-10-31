import { collides, hardDropY, isGrounded, spawnPos, tryRotate, type PiecePos } from "./board.js";
import type { PieceType } from "./pieces.js";
import type { PlayerSim, Placement } from "./player-sim.js";

export interface ControllerConfig {
  /** Milliseconds per row of gravity. */
  gravityMs: number;
  /** Multiplier applied to gravity while soft drop is held. */
  softDropFactor: number;
  lockDelayMs: number;
  maxLockResets: number;
}

export const DEFAULT_CONTROLLER_CONFIG: ControllerConfig = {
  gravityMs: 1000,
  softDropFactor: 20,
  lockDelayMs: 500,
  maxLockResets: 15,
};

export type Command = "left" | "right" | "cw" | "ccw" | "hardDrop" | "hold" | "softDropOn" | "softDropOff";

/**
 * Drives the falling piece for the LOCAL player: gravity, lock delay, moves.
 * It never mutates the PlayerSim; when the piece locks it emits a Placement that
 * the caller feeds to sim.applyPlacement (the same path the host uses).
 */
export class LiveController {
  piece: PiecePos;
  private usedHold = false;
  private lastMoveRotate = false;
  private kickIndex = -1;
  private gravityAcc = 0;
  private lockTimer = 0;
  private lockResets = 0;
  private softDrop = false;
  private lowestY: number;

  constructor(
    private readonly sim: PlayerSim,
    private cfg: ControllerConfig = DEFAULT_CONTROLLER_CONFIG,
  ) {
    this.piece = spawnPos(sim.s.active);
    this.lowestY = this.piece.y;
  }

  setConfig(cfg: Partial<ControllerConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  get holdUsed(): boolean {
    return this.usedHold;
  }

  /**
   * What the Hold box should show right now. The sim only records the swap
   * when the piece locks (it is part of the Placement), so while a held turn
   * is in progress the held piece is the sim's current active piece.
   */
  displayHold(): PieceType | null {
    return this.usedHold ? this.sim.s.active : this.sim.s.hold;
  }

  /** Upcoming pieces as the player sees them (first hold pulls one from the queue). */
  displayNext(count: number): PieceType[] {
    const skip = this.usedHold && this.sim.s.hold === null ? 1 : 0;
    return this.sim.preview(count + skip).slice(skip);
  }

  /** Call after sim.applyPlacement (or a resync) to start the next piece. */
  reset(): void {
    this.piece = spawnPos(this.sim.s.active);
    this.usedHold = false;
    this.lastMoveRotate = false;
    this.kickIndex = -1;
    this.gravityAcc = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.lowestY = this.piece.y;
  }

  ghostY(): number {
    return hardDropY(this.sim.s.board, this.piece);
  }

  /** Returns a Placement if the command caused a lock. */
  command(cmd: Command): Placement | null {
    const board = this.sim.s.board;
    switch (cmd) {
      case "left":
      case "right": {
        const n = { ...this.piece, x: this.piece.x + (cmd === "left" ? -1 : 1) };
        if (!collides(board, n)) {
          this.piece = n;
          this.lastMoveRotate = false;
          this.kickIndex = -1;
          this.onMoved();
        }
        return null;
      }
      case "cw":
      case "ccw": {
        const r = tryRotate(board, this.piece, cmd === "cw" ? 1 : -1);
        if (r) {
          this.piece = r.pos;
          this.lastMoveRotate = true;
          this.kickIndex = r.kickIndex;
          this.onMoved();
        }
        return null;
      }
      case "hold": {
        if (this.usedHold) return null;
        const type = this.sim.holdSwapType();
        this.usedHold = true;
        this.piece = spawnPos(type);
        this.lastMoveRotate = false;
        this.kickIndex = -1;
        this.gravityAcc = 0;
        this.lockTimer = 0;
        this.lockResets = 0;
        this.lowestY = this.piece.y;
        return null;
      }
      case "hardDrop": {
        const y = hardDropY(board, this.piece);
        if (y !== this.piece.y) {
          this.piece = { ...this.piece, y };
          this.lastMoveRotate = false;
          this.kickIndex = -1;
        }
        return this.lock();
      }
      case "softDropOn":
        this.softDrop = true;
        return null;
      case "softDropOff":
        this.softDrop = false;
        return null;
    }
  }

  tick(dtMs: number): Placement | null {
    const board = this.sim.s.board;
    if (collides(board, this.piece)) return null; // block-out: sim will report top-out
    const ms = this.softDrop ? this.cfg.gravityMs / this.cfg.softDropFactor : this.cfg.gravityMs;
    this.gravityAcc += dtMs;
    while (this.gravityAcc >= ms) {
      this.gravityAcc -= ms;
      if (isGrounded(board, this.piece)) break;
      this.piece = { ...this.piece, y: this.piece.y + 1 };
      this.lastMoveRotate = false;
      this.kickIndex = -1;
      if (this.piece.y > this.lowestY) {
        this.lowestY = this.piece.y;
        this.lockResets = 0;
      }
    }
    if (isGrounded(board, this.piece)) {
      this.lockTimer += dtMs;
      if (this.lockTimer >= this.cfg.lockDelayMs) return this.lock();
    } else {
      this.lockTimer = 0;
    }
    return null;
  }

  private onMoved(): void {
    if (isGrounded(this.sim.s.board, this.piece) && this.lockResets < this.cfg.maxLockResets) {
      this.lockTimer = 0;
      this.lockResets++;
    }
  }

  private lock(): Placement {
    return {
      pieceIndex: this.sim.s.piecesPlaced,
      type: this.piece.type,
      usedHold: this.usedHold,
      x: this.piece.x,
      y: this.piece.y,
      rot: this.piece.rot,
      lastMoveRotate: this.lastMoveRotate,
      kickIndex: this.lastMoveRotate ? this.kickIndex : -1,
      garbageIds: [],
    };
  }
}

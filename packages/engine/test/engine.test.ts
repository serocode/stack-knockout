import { describe, expect, it } from "vitest";
import {
  BOARD_WIDTH,
  PIECE_TYPES,
  PlayerSim,
  analyzeReach,
  bagPeek,
  botPlacement,
  cancelGarbage,
  computeAttack,
  createBag,
  createBoard,
  detectTSpin,
  insertGarbage,
  tryRotate,
  LiveController,
  type Board,
  type Placement,
} from "@tk/engine";

function fill(board: Board, y: number, except: number[] = []): void {
  for (let x = 0; x < BOARD_WIDTH; x++) if (!except.includes(x)) board[y * BOARD_WIDTH + x] = 8;
}

/** A sim whose active piece is forced to `type` (tests only). */
function simWith(type: (typeof PIECE_TYPES)[number], seed = 1): PlayerSim {
  const sim = PlayerSim.create(seed);
  sim.s.active = type;
  return sim;
}

describe("seven-bag randomizer", () => {
  it("emits every piece exactly once per bag", () => {
    const bag = createBag(12345);
    const seq = bagPeek(bag, 70);
    for (let i = 0; i < 70; i += 7) {
      expect(new Set(seq.slice(i, i + 7)).size).toBe(7);
    }
  });
  it("is deterministic for a seed", () => {
    expect(bagPeek(createBag(99), 21)).toEqual(bagPeek(createBag(99), 21));
    expect(bagPeek(createBag(99), 21)).not.toEqual(bagPeek(createBag(100), 21));
  });
});

describe("SRS rotation", () => {
  it("kicks an I piece off the left wall", () => {
    const board = createBoard();
    // vertical I hugging the left wall (state L: cells in box column 1)
    const r = tryRotate(board, { type: "I", x: -1, y: 30, rot: 3 }, 1);
    expect(r).not.toBeNull();
    expect(r!.kickIndex).toBeGreaterThan(0);
  });
  it("O piece never moves when rotated", () => {
    const r = tryRotate(createBoard(), { type: "O", x: 3, y: 30, rot: 0 }, 1);
    expect(r!.pos.x).toBe(3);
    expect(r!.pos.y).toBe(30);
    expect(r!.kickIndex).toBe(0);
  });
});

describe("T-spin detection", () => {
  it("detects a mini with one front corner and upgrades it on kick 4", () => {
    const board = createBoard();
    board[38 * BOARD_WIDTH + 0] = 8; // top-left corner of the T box
    const pos = { type: "T" as const, x: 0, y: 38, rot: 0 as const };
    expect(detectTSpin(board, pos, true, 0)).toBe("mini");
    expect(detectTSpin(board, pos, true, 4)).toBe("full");
    expect(detectTSpin(board, pos, false, -1)).toBe("none");
  });

  it("scores a T-spin double through the full placement path", () => {
    const sim = simWith("T");
    const b = sim.s.board;
    fill(b, 39, [4]);
    fill(b, 38, [3, 4, 5]);
    b[37 * BOARD_WIDTH + 3] = 8; // overhang
    const target = { x: 3, y: 37, rot: 2 as const };
    const reach = analyzeReach(b, "T", target);
    expect(reach.reachable).toBe(true);
    const kick = [0, 1, 2, 3, 4].find((k) => reach.rotationKicks & (1 << k))!;
    const out = sim.applyPlacement(
      { pieceIndex: 0, type: "T", usedHold: false, ...target, lastMoveRotate: true, kickIndex: kick, garbageIds: [] },
      [],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.tspin).toBe("full");
    expect(out.result.lines).toBe(2);
    expect(out.result.attack).toBe(4);
  });
});

describe("attack table", () => {
  it("covers base clears, b2b, combos and perfect clears", () => {
    const base = { tspin: "none" as const, perfectClear: false, combo: 0, b2bBonus: false };
    expect(computeAttack({ ...base, lines: 1 })).toBe(0);
    expect(computeAttack({ ...base, lines: 2 })).toBe(1);
    expect(computeAttack({ ...base, lines: 3 })).toBe(2);
    expect(computeAttack({ ...base, lines: 4 })).toBe(4);
    expect(computeAttack({ ...base, lines: 4, b2bBonus: true })).toBe(5);
    expect(computeAttack({ ...base, lines: 2, tspin: "full" })).toBe(4);
    expect(computeAttack({ ...base, lines: 3, tspin: "full", b2bBonus: true })).toBe(7);
    expect(computeAttack({ ...base, lines: 1, tspin: "mini" })).toBe(0);
    expect(computeAttack({ ...base, lines: 1, combo: 4 })).toBe(2);
    expect(computeAttack({ ...base, lines: 4, perfectClear: true })).toBe(14);
  });

  it("tracks back-to-back across 4-line clears", () => {
    const sim = simWith("I");
    const b = sim.s.board;
    for (let y = 36; y < 40; y++) fill(b, y, [9]);
    let out = sim.applyPlacement(
      { pieceIndex: 0, type: "I", usedHold: false, x: 7, y: 36, rot: 1, lastMoveRotate: false, kickIndex: -1, garbageIds: [] },
      [],
    );
    expect(out.ok && out.result.lines).toBe(4);
    expect(out.ok && out.result.perfectClear).toBe(true);
    expect(out.ok && out.result.b2bBonus).toBe(false);
    for (let y = 36; y < 40; y++) fill(b, y, [9]);
    sim.s.active = "I";
    out = sim.applyPlacement(
      { pieceIndex: 1, type: "I", usedHold: false, x: 7, y: 36, rot: 1, lastMoveRotate: false, kickIndex: -1, garbageIds: [] },
      [],
    );
    expect(out.ok && out.result.b2bBonus).toBe(true);
    expect(out.ok && out.result.combo).toBe(1);
    // 4 base + 1 b2b + 1 combo + 10 perfect clear
    expect(out.ok && out.result.attack).toBe(16);
  });

  it("cancels incoming garbage oldest-first", () => {
    const r = cancelGarbage([{ id: "a", lines: 2 }, { id: "b", lines: 3 }], 4);
    expect(r.remaining).toBe(0);
    expect(r.queue).toEqual([{ id: "b", lines: 1 }]);
    expect(r.cancelled).toEqual([{ id: "a", lines: 2 }, { id: "b", lines: 2 }]);
    expect(cancelGarbage([{ id: "a", lines: 1 }], 3).remaining).toBe(2);
  });
});

describe("placement validation (host shadow)", () => {
  const drop = (sim: PlayerSim, over: Partial<Placement>): Placement => ({
    pieceIndex: sim.s.piecesPlaced,
    type: sim.s.active,
    usedHold: false,
    x: 3,
    y: 38,
    rot: 0,
    lastMoveRotate: false,
    kickIndex: -1,
    garbageIds: [],
    ...over,
  });

  it("rejects wrong piece, wrong index, floating and colliding placements", () => {
    const sim = simWith("O");
    expect(sim.applyPlacement(drop(sim, { type: "T" }), []).ok).toBe(false);
    expect(sim.applyPlacement(drop(sim, { pieceIndex: 5 }), [])).toEqual({ ok: false, error: "wrong-index" });
    expect(sim.applyPlacement(drop(sim, { y: 30 }), [])).toEqual({ ok: false, error: "not-grounded" });
    expect(sim.applyPlacement(drop(sim, { y: 39 }), [])).toEqual({ ok: false, error: "collision" });
    expect(sim.applyPlacement(drop(sim, {}), []).ok).toBe(true);
  });

  it("rejects placements under a ceiling that cannot be reached", () => {
    const sim = simWith("I");
    fill(sim.s.board, 38);
    const out = sim.applyPlacement(drop(sim, { x: 0, y: 38, rot: 0 }), []);
    expect(out).toEqual({ ok: false, error: "unreachable" });
  });

  it("rejects a fabricated rotation claim", () => {
    const sim = simWith("T");
    const out = sim.applyPlacement(drop(sim, { y: 38, lastMoveRotate: true, kickIndex: 3 }), []);
    expect(out).toEqual({ ok: false, error: "invalid-spin" });
  });

  it("handles hold transitions identically on both sides", () => {
    const sim = PlayerSim.create(7);
    const first = sim.s.active;
    const second = sim.preview(1)[0]!;
    const out = sim.applyPlacement(drop(sim, { type: second, usedHold: true, x: 3, y: 0 }), []);
    // y is wrong on purpose -> rejected without mutating state
    expect(out.ok).toBe(false);
    expect(sim.s.hold).toBeNull();
    const ctl = new LiveController(sim);
    ctl.command("hold");
    const p = ctl.command("hardDrop")!;
    expect(p.type).toBe(second);
    expect(sim.applyPlacement(p, []).ok).toBe(true);
    expect(sim.s.hold).toBe(first);
  });

  it("inserts garbage and tops out when pushed past the ceiling", () => {
    const b = createBoard();
    b[0] = 3;
    expect(insertGarbage(b, 1, 0)).toBe(true);
    const sim = simWith("O");
    const out = sim.applyPlacement(drop(sim, { garbageIds: ["g1"] }), [{ id: "g1", lines: 40, holeCol: 2 }]);
    expect(out.ok && out.result.toppedOut).toBe(true);
  });
});

describe("hold display", () => {
  it("shows the held piece immediately, including the very first hold, and shifts Next", () => {
    const sim = PlayerSim.create(2024);
    const ctl = new LiveController(sim);
    const first = sim.s.active;
    const queue = sim.preview(6);
    expect(ctl.displayHold()).toBeNull();
    expect(ctl.displayNext(5)).toEqual(queue.slice(0, 5));
    ctl.command("hold");
    expect(ctl.displayHold()).toBe(first); // previously null until the piece locked
    expect(ctl.piece.type).toBe(queue[0]);
    expect(ctl.displayNext(5)).toEqual(queue.slice(1, 6));
    expect(sim.applyPlacement(ctl.command("hardDrop")!, []).ok).toBe(true);
    ctl.reset();
    expect(ctl.displayHold()).toBe(first);
    // Second hold swaps with the held piece; Next does not shift.
    const active = sim.s.active;
    const next = ctl.displayNext(5);
    ctl.command("hold");
    expect(ctl.displayHold()).toBe(active);
    expect(ctl.piece.type).toBe(first);
    expect(ctl.displayNext(5)).toEqual(next);
  });
});

describe("read-only access never changes state", () => {
  it("peeking previews (as the UI does every frame) leaves the hash unchanged", () => {
    const a = PlayerSim.create(31337);
    const b = PlayerSim.create(31337);
    let rng = 9;
    for (let i = 0; i < 40; i++) {
      a.preview(5);
      a.preview(14);
      a.holdSwapType();
      const r = botPlacement(b, rng);
      rng = r.rng;
      expect(a.applyPlacement(r.placement!, []).ok).toBe(true);
      expect(b.applyPlacement(r.placement!, []).ok).toBe(true);
      expect(a.hash()).toBe(b.hash());
    }
  });
});

describe("determinism", () => {
  it("two sims fed the same placements stay hash-identical, and survive serialization", () => {
    const a = PlayerSim.create(424242);
    const host = PlayerSim.create(424242);
    let rng = 5;
    for (let i = 0; i < 120 && !a.s.toppedOut; i++) {
      const r = botPlacement(a, rng);
      rng = r.rng;
      if (!r.placement) break;
      const garbage = i % 9 === 8 ? [{ id: `g${i}`, lines: 1, holeCol: i % 10 }] : [];
      const p = { ...r.placement, garbageIds: garbage.map((g) => g.id) };
      const la = a.applyPlacement(p, garbage);
      const lh = host.applyPlacement(p, garbage);
      expect(la.ok).toBe(true);
      expect(lh).toEqual(la);
      expect(host.hash()).toBe(a.hash());
    }
    expect(a.s.piecesPlaced).toBeGreaterThan(50);
    expect(PlayerSim.deserialize(a.serialize()).hash()).toBe(a.hash());
  });
});

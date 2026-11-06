import { describe, expect, it } from "vitest";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  BOMB_CELL,
  GARBAGE_CELL,
  PlayerSim,
  boardToString,
  clearLines,
  clearLinesWithBombs,
  createBoard,
  insertGarbage,
  type Board,
} from "@tk/engine";

const at = (b: Board, x: number, y: number) => b[y * BOARD_WIDTH + x]!;
const set = (b: Board, x: number, y: number, v: number) => void (b[y * BOARD_WIDTH + x] = v);
const B = BOARD_HEIGHT - 1; // bottom row

describe("bomb garbage", () => {
  it("insertGarbage puts a bomb in the chosen rows only", () => {
    const b = createBoard();
    insertGarbage(b, 3, 0, 4, [0, 2]);
    // Row offset 0 is the topmost new row.
    expect(at(b, 4, B - 2)).toBe(BOMB_CELL);
    expect(at(b, 4, B - 1)).toBe(GARBAGE_CELL);
    expect(at(b, 4, B)).toBe(BOMB_CELL);
    for (let y = B - 2; y <= B; y++) expect(at(b, 0, y)).toBe(0);
  });

  it("without bombs it behaves exactly like clearLines", () => {
    const a = createBoard();
    insertGarbage(a, 6, 2);
    for (let x = 0; x < BOARD_WIDTH; x++) set(a, x, B - 4, 3);
    set(a, 2, B - 1, 1);
    const b = a.slice();
    const n = clearLines(a);
    const r = clearLinesWithBombs(b, "line");
    expect(r.lines).toBe(n);
    expect(r.detonations).toEqual([]);
    expect(boardToString(b)).toBe(boardToString(a));
  });

  it("line blast clears the row beneath and chains through stacked bombs", () => {
    const b = createBoard();
    insertGarbage(b, 3, 0, 5, [0, 1, 2]);
    set(b, 0, B - 2, 1); // fill the top row's hole
    const r = clearLinesWithBombs(b, "line");
    expect(r.lines).toBe(1);
    expect(r.blastedRows).toBe(2);
    expect(r.detonations).toEqual([[5, B - 2], [5, B - 1], [5, B]]);
    expect(r.removedRows).toEqual([B - 2, B - 1, B]);
    expect(b.every((v) => v === 0)).toBe(true);
  });

  it("area blast empties the eight neighbours, then rows collapse", () => {
    const b = createBoard();
    insertGarbage(b, 2, 0, 5, [0]); // bomb at (5, B-1)
    for (let x = 3; x <= 7; x++) set(b, x, B - 2, 2); // stack above
    set(b, 0, B - 1, 1);
    const r = clearLinesWithBombs(b, "area");
    expect(r.lines).toBe(1);
    expect(r.blastedRows).toBe(0);
    // Bottom row lost x=4..6; the stack row lost x=4..6 and dropped one row.
    for (let x = 4; x <= 6; x++) {
      expect(at(b, x, B)).toBe(0);
      expect(at(b, x, B - 1)).toBe(0);
    }
    expect(at(b, 3, B)).toBe(GARBAGE_CELL);
    expect(at(b, 3, B - 1)).toBe(2);
    expect(at(b, 7, B - 1)).toBe(2);
  });

  it("column blast drills straight down to the floor", () => {
    const b = createBoard();
    insertGarbage(b, 4, 0, 6, [0]);
    set(b, 0, B - 3, 1);
    const r = clearLinesWithBombs(b, "column");
    expect(r.lines).toBe(1);
    for (let y = B - 2; y <= B; y++) {
      expect(at(b, 6, y)).toBe(0);
      expect(at(b, 5, y)).toBe(GARBAGE_CELL);
    }
  });

  it("the sim adds bonus attack per bomb and keeps its settings through serialize", () => {
    const sim = PlayerSim.create(5, { blast: "area", bonus: 2 });
    sim.s.active = "I";
    insertGarbage(sim.s.board, 1, 9); // floor row, hole far right
    for (let x = 4; x < BOARD_WIDTH; x++) set(sim.s.board, x, B - 1, x === 5 ? BOMB_CELL : GARBAGE_CELL);
    const out = sim.applyPlacement({ pieceIndex: 0, type: "I", usedHold: false, x: 0, y: B - 2, rot: 0, lastMoveRotate: false, kickIndex: -1, garbageIds: [] }, []);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.lines).toBe(1);
    expect(out.result.bombs).toBe(1);
    expect(out.result.attack).toBe(2); // single = 0, + 2 for the bomb
    expect(out.result.perfectClear).toBe(false);
    const copy = PlayerSim.deserialize(sim.serialize());
    expect(copy.s.bombs).toEqual({ blast: "area", bonus: 2 });
    expect(copy.hash()).toBe(sim.hash());
  });

  it("rejects bomb chunks that put the bomb in the hole or outside the chunk", () => {
    const sim = PlayerSim.create(9);
    const pl = { pieceIndex: 0, type: sim.s.active, usedHold: false, x: 3, y: 37, rot: 0 as const, lastMoveRotate: false, kickIndex: -1, garbageIds: ["c0"] };
    expect(sim.clone().applyPlacement(pl, [{ id: "c0", lines: 2, holeCol: 3, bombCol: 3, bombRows: [0] }])).toEqual({ ok: false, error: "bad-garbage" });
    expect(sim.clone().applyPlacement(pl, [{ id: "c0", lines: 2, holeCol: 3, bombCol: 4, bombRows: [2] }])).toEqual({ ok: false, error: "bad-garbage" });
  });
});

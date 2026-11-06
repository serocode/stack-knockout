/**
 * Tetromino definitions and SRS kick tables (the standard Super Rotation System).
 * Coordinates: x grows right, y grows DOWN. Rotation states: 0, R(1), 2, L(3).
 */
export const PIECE_TYPES = ["I", "O", "T", "S", "Z", "J", "L"] as const;
export type PieceType = (typeof PIECE_TYPES)[number];
export type Rotation = 0 | 1 | 2 | 3;
export type Cell = readonly [x: number, y: number];

/** Cell value written to the board for each piece type (0 = empty, 8 = garbage, 9 = bomb garbage). */
export const PIECE_CELL: Record<PieceType, number> = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7 };
export const GARBAGE_CELL = 8;
/** A garbage cell that detonates when its row is cleared. */
export const BOMB_CELL = 9;

const BASE: Record<PieceType, { size: number; cells: Cell[] }> = {
  I: { size: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  O: { size: 4, cells: [[1, 0], [2, 0], [1, 1], [2, 1]] },
  T: { size: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  S: { size: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  Z: { size: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  J: { size: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { size: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
};

function rotateCW(cells: Cell[], size: number): Cell[] {
  return cells.map(([x, y]) => [size - 1 - y, x] as const);
}

/** SHAPES[type][rotation] -> 4 cells relative to the piece box origin. */
export const SHAPES: Record<PieceType, readonly (readonly Cell[])[]> = (() => {
  const out = {} as Record<PieceType, Cell[][]>;
  for (const t of PIECE_TYPES) {
    const { size, cells } = BASE[t];
    if (t === "O") {
      out[t] = [cells, cells, cells, cells];
      continue;
    }
    const r0 = cells;
    const r1 = rotateCW(r0, size);
    const r2 = rotateCW(r1, size);
    const r3 = rotateCW(r2, size);
    out[t] = [r0, r1, r2, r3];
  }
  return out;
})();

/** Kicks are written y-up in the Guideline; converted to y-down on load. */
type KickTable = Record<string, readonly Cell[]>;
const toDown = (list: [number, number][]): Cell[] => list.map(([x, y]) => [x, -y] as const);

const JLSTZ_KICKS: KickTable = {
  "0>1": toDown([[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]]),
  "1>0": toDown([[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]),
  "1>2": toDown([[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]),
  "2>1": toDown([[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]]),
  "2>3": toDown([[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]),
  "3>2": toDown([[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]]),
  "3>0": toDown([[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]]),
  "0>3": toDown([[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]]),
};

const I_KICKS: KickTable = {
  "0>1": toDown([[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]]),
  "1>0": toDown([[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]]),
  "1>2": toDown([[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]]),
  "2>1": toDown([[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]]),
  "2>3": toDown([[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]]),
  "3>2": toDown([[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]]),
  "3>0": toDown([[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]]),
  "0>3": toDown([[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]]),
};

const O_KICKS: readonly Cell[] = [[0, 0]];

export function kicksFor(type: PieceType, from: Rotation, to: Rotation): readonly Cell[] {
  if (type === "O") return O_KICKS;
  const table = type === "I" ? I_KICKS : JLSTZ_KICKS;
  return table[`${from}>${to}`]!;
}

export function isPieceType(v: unknown): v is PieceType {
  return typeof v === "string" && (PIECE_TYPES as readonly string[]).includes(v);
}

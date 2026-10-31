/**
 * Attack (garbage) and score tables. Pure functions so the host can recompute
 * every claim independently.
 */
export type TSpinKind = "none" | "mini" | "full";

export interface ClearInfo {
  lines: number;
  tspin: TSpinKind;
  perfectClear: boolean;
  /** Combo counter AFTER this placement (-1 = no combo, 0 = first clear in a chain). */
  combo: number;
  /** True if this clear received the back-to-back bonus. */
  b2bBonus: boolean;
}

const BASE_ATTACK: Record<TSpinKind, readonly number[]> = {
  none: [0, 0, 1, 2, 4],
  mini: [0, 0, 1, 2],
  full: [0, 2, 4, 6],
};

/** Guideline-style combo table indexed by combo count (0 = first clear). */
export const COMBO_TABLE = [0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5] as const;
export const PERFECT_CLEAR_ATTACK = 10;
export const B2B_ATTACK_BONUS = 1;

export function comboBonus(combo: number): number {
  if (combo <= 0) return 0;
  return COMBO_TABLE[Math.min(combo, COMBO_TABLE.length - 1)]!;
}

export function isDifficult(lines: number, tspin: TSpinKind): boolean {
  return lines === 4 || (tspin !== "none" && lines > 0);
}

export function computeAttack(c: ClearInfo): number {
  if (c.lines === 0) return 0;
  const base = BASE_ATTACK[c.tspin][c.lines] ?? 0;
  return base + (c.b2bBonus ? B2B_ATTACK_BONUS : 0) + comboBonus(c.combo) + (c.perfectClear ? PERFECT_CLEAR_ATTACK : 0);
}

const SCORE_TABLE: Record<TSpinKind, readonly number[]> = {
  none: [0, 100, 300, 500, 800],
  mini: [100, 200, 400],
  full: [400, 800, 1200, 1600],
};
const PC_SCORE = [0, 800, 1200, 1800, 2000] as const;

export function computeScore(c: ClearInfo): number {
  let s = SCORE_TABLE[c.tspin][c.lines] ?? 0;
  if (c.b2bBonus) s = Math.floor(s * 1.5);
  if (c.combo > 0) s += 50 * c.combo;
  if (c.perfectClear) s += PC_SCORE[c.lines] ?? 0;
  return s;
}

export interface GarbageQueueEntry {
  id: string;
  lines: number;
}

/**
 * Cancels outgoing attack against an incoming queue (oldest first).
 * Returns the remaining attack and the new queue. Does not mutate.
 */
export function cancelGarbage(
  queue: readonly GarbageQueueEntry[],
  attack: number,
): { remaining: number; queue: GarbageQueueEntry[]; cancelled: { id: string; lines: number }[] } {
  let remaining = attack;
  const out: GarbageQueueEntry[] = [];
  const cancelled: { id: string; lines: number }[] = [];
  for (const e of queue) {
    if (remaining <= 0) {
      out.push({ ...e });
      continue;
    }
    const used = Math.min(e.lines, remaining);
    remaining -= used;
    cancelled.push({ id: e.id, lines: used });
    if (e.lines - used > 0) out.push({ id: e.id, lines: e.lines - used });
  }
  return { remaining, queue: out, cancelled };
}

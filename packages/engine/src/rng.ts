/**
 * Deterministic, serializable PRNG (mulberry32). State is a single uint32 so it
 * can be stored in snapshots and replayed identically on every peer.
 */
export type RngState = number;

export function rngNext(state: RngState): [value: number, next: RngState] {
  const s = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s >>> 0];
}

/** Integer in [0, n). */
export function rngInt(state: RngState, n: number): [value: number, next: RngState] {
  const [v, next] = rngNext(state);
  return [Math.floor(v * n), next];
}

/** 32-bit FNV-1a hash of a string, used to derive seeds and state hashes. */
export function hashString(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function hashBytes(bytes: ArrayLike<number>, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]! & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Derive a per-player seed from a match seed so every peer can predict any player's bag. */
export function deriveSeed(matchSeed: number, label: string): number {
  return hashString(label, matchSeed >>> 0) || 1;
}

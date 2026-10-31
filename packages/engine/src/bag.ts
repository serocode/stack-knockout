import { PIECE_TYPES, type PieceType } from "./pieces.js";
import { rngInt, type RngState } from "./rng.js";

/** Seven-bag randomizer. Serializable: rng state + already-generated upcoming pieces. */
export interface BagState {
  rng: RngState;
  queue: PieceType[];
}

/**
 * Invariant: after creation and after every draw, at least BAG_LOOKAHEAD pieces
 * are materialized. Peeking up to that many therefore never mutates state, so
 * a UI showing previews can never change the state hash. (A lazily-refilled
 * bag made identical games hash differently depending on how far ahead the UI
 * had peeked.)
 */
export const BAG_LOOKAHEAD = 7;

export function createBag(seed: number): BagState {
  const bag: BagState = { rng: seed >>> 0, queue: [] };
  while (bag.queue.length < BAG_LOOKAHEAD) refill(bag);
  return bag;
}

function refill(bag: BagState): void {
  const pieces = [...PIECE_TYPES] as PieceType[];
  let rng = bag.rng;
  for (let i = pieces.length - 1; i > 0; i--) {
    const [j, next] = rngInt(rng, i + 1);
    rng = next;
    const tmp = pieces[i]!;
    pieces[i] = pieces[j]!;
    pieces[j] = tmp;
  }
  bag.rng = rng;
  bag.queue.push(...pieces);
}

/** Non-mutating peek (works on a copy if it must look past the materialized pieces). */
export function bagPeek(bag: BagState, count: number): PieceType[] {
  if (bag.queue.length >= count) return bag.queue.slice(0, count);
  const copy = cloneBag(bag);
  while (copy.queue.length < count) refill(copy);
  return copy.queue.slice(0, count);
}

export function bagDraw(bag: BagState): PieceType {
  if (bag.queue.length === 0) refill(bag);
  const p = bag.queue.shift()!;
  while (bag.queue.length < BAG_LOOKAHEAD) refill(bag);
  return p;
}

export function cloneBag(bag: BagState): BagState {
  return { rng: bag.rng, queue: [...bag.queue] };
}

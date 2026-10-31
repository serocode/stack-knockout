import {
  applyEntry,
  createRoomState,
  deserializeState,
  isLogEntry,
  serializeState,
  stateHash,
  DEFAULT_RULES,
  type ApplyResult,
  type LogEntry,
  type RoomState,
  type Rules,
  type SerializedRoomState,
} from "./state.js";
import { isInt, isObj } from "./validate.js";

/**
 * A snapshot of the replicated state at `seq`, plus every entry after it.
 * This is exactly what a node contributes when it votes, and what a host
 * sends when it (re)synchronises a follower.
 */
export interface LogExport {
  checkpoint: { seq: number; epoch: number; hash: number; state: SerializedRoomState };
  entries: LogEntry[];
}

export const MAX_EXPORT_ENTRIES = 2000;

/**
 * Local copy of the authoritative event log. Every node keeps one; only the
 * host appends to it. Periodic local checkpoints keep it bounded (spec §6
 * "All players must periodically maintain a local snapshot of the match").
 */
export class ReplicatedLog {
  state: RoomState;
  private cp: LogExport["checkpoint"];
  private entries: LogEntry[] = [];

  private constructor(
    cp: LogExport["checkpoint"],
    state: RoomState,
    readonly rules: Rules,
  ) {
    this.cp = cp;
    this.state = state;
  }

  static fresh(rules: Rules = DEFAULT_RULES): ReplicatedLog {
    const state = createRoomState();
    return new ReplicatedLog({ seq: 0, epoch: 0, hash: stateHash(state), state: serializeState(state) }, state, rules);
  }

  /** Rebuild from an untrusted export by replaying it. Throws if anything does not check out. */
  static fromExport(x: unknown, rules: Rules = DEFAULT_RULES): ReplicatedLog {
    if (!isObj(x) || !isObj(x.checkpoint) || !Array.isArray(x.entries)) throw new Error("export shape");
    const cp = x.checkpoint;
    if (!isInt(cp.seq, 0, Number.MAX_SAFE_INTEGER) || !isInt(cp.epoch, 0, Number.MAX_SAFE_INTEGER) || !isInt(cp.hash, 0, 0xffffffff))
      throw new Error("checkpoint fields");
    if (x.entries.length > MAX_EXPORT_ENTRIES) throw new Error("too many entries");
    const state = deserializeState(cp.state);
    if (stateHash(state) !== cp.hash) throw new Error("checkpoint hash mismatch");
    const log = new ReplicatedLog({ seq: cp.seq, epoch: cp.epoch, hash: cp.hash, state: serializeState(state) }, state, rules);
    let expect = cp.seq + 1;
    let lastEpoch = cp.epoch;
    for (const e of x.entries) {
      if (!isLogEntry(e) || e.seq !== expect || e.epoch < lastEpoch) throw new Error("entry sequence");
      const r = log.apply(e);
      if (!r.ok) throw new Error(`entry ${e.seq} rejected: ${r.error}`);
      expect++;
      lastEpoch = e.epoch;
    }
    return log;
  }

  get lastSeq(): number {
    return this.entries.at(-1)?.seq ?? this.cp.seq;
  }

  get lastEpoch(): number {
    return this.entries.at(-1)?.epoch ?? this.cp.epoch;
  }

  get checkpointSeq(): number {
    return this.cp.seq;
  }

  /** Raft-style comparison: later epoch wins, then longer log. */
  static compare(a: { lastEpoch: number; lastSeq: number }, b: { lastEpoch: number; lastSeq: number }): number {
    return a.lastEpoch !== b.lastEpoch ? a.lastEpoch - b.lastEpoch : a.lastSeq - b.lastSeq;
  }

  /** Validates and applies one entry (which must be the next seq). No mutation on failure. */
  apply(e: LogEntry): ApplyResult {
    if (e.seq !== this.lastSeq + 1) return { ok: false, error: "seq-gap" };
    if (e.epoch < this.lastEpoch) return { ok: false, error: "stale-epoch" };
    const r = applyEntry(this.state, e, this.rules);
    if (r.ok) this.entries.push(e);
    return r;
  }

  /** Dry-run on a copy; used by the host before it commits to appending. */
  check(e: LogEntry): ApplyResult {
    const copy = deserializeState(serializeState(this.state));
    return applyEntry(copy, e, this.rules);
  }

  entriesAfter(seq: number): LogEntry[] {
    return this.entries.filter((e) => e.seq > seq);
  }

  export(): LogExport {
    return { checkpoint: { ...this.cp }, entries: this.entries.map((e) => structuredClone(e)) };
  }

  /** Take a local checkpoint at `upTo` (must be committed) once enough entries pile up. */
  maybeCheckpoint(upTo: number, every: number): void {
    if (this.entries.length < every * 2 || upTo - this.cp.seq < every) return;
    const target = Math.min(upTo, this.lastSeq);
    const state = deserializeState(this.cp.state);
    const keep: LogEntry[] = [];
    let lastEpoch = this.cp.epoch;
    for (const e of this.entries) {
      if (e.seq <= target) {
        const r = applyEntry(state, e, this.rules);
        if (!r.ok) return; // should never happen; keep the old checkpoint
        lastEpoch = e.epoch;
      } else keep.push(e);
    }
    this.cp = { seq: target, epoch: lastEpoch, hash: stateHash(state), state: serializeState(state) };
    this.entries = keep;
  }
}

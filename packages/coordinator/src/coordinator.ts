import { PlayerSim, isPieceType, type GarbageChunk, type LockResult, type PiecePos, type Placement } from "@tk/engine";
import { Emitter, randomBytes, type Clock, type Mesh, type MeshMessage, type TimerHandle } from "@tk/net";
import { ReplicatedLog, type LogExport } from "./log.js";
import {
  DEFAULT_RULES,
  MIN_PLAYERS,
  findRoster,
  isLogEntry,
  isMatchOptions,
  type MatchOptions,
  type Effect,
  type EntryBody,
  type LogEntry,
  type RoomState,
  type Rules,
  type TargetMode,
} from "./state.js";
import { cleanName, isBool, isCosmetics, isInt, isObj, isPid, isPlacement, isStr, type Cosmetics } from "./validate.js";

export interface CoordinatorConfig {
  /** Follower declares the host lost after this long without host traffic. */
  hostTimeoutMs: number;
  /** Delay per rank before a lower-priority node stands for election. */
  electionStaggerMs: number;
  /** An election attempt that has not reached quorum by now is abandoned and retried. */
  electionTimeoutMs: number;
  /** Host steps down if it cannot hear a quorum within this window (match phases only). */
  leaseMs: number;
  /** If no host can be established for this long mid-match, the match ends with no result. */
  migrationGiveUpMs: number;
  /** Disconnected players keep their identity this long before being removed (forfeit in a match). */
  reconnectGraceMs: number;
  countdownMs: number;
  /** Pause after a migration before play resumes. */
  resumeDelayMs: number;
  checkpointEvery: number;
  tickMs: number;
}

export const DEFAULT_CONFIG: CoordinatorConfig = {
  hostTimeoutMs: 2500,
  electionStaggerMs: 500,
  electionTimeoutMs: 2500,
  leaseMs: 3000,
  migrationGiveUpMs: 20_000,
  reconnectGraceMs: 30_000,
  countdownMs: 3000,
  resumeDelayMs: 1500,
  checkpointEvery: 32,
  tickMs: 100,
};

export type NodeMode = "joining" | "follower" | "host" | "leaderless" | "candidate" | "rejected" | "left";

export type CoordinatorEvent =
  | { kind: "effect"; effect: Effect; committed: boolean }
  | { kind: "migration-start"; formerHost: string | null; reason: string }
  | { kind: "host-changed"; hostId: string; epoch: number; recoveredFrom?: string }
  | { kind: "match-abandoned" }
  | { kind: "resync"; reason: string }
  | { kind: "rejected"; reason: string }
  | { kind: "peer"; playerId: string; up: boolean }
  | { kind: "suggestion"; suggestion: Suggestion }
  | { kind: "suggestion-taken"; player: string; coach: string }
  | { kind: "callout"; from: string; code: string; about: string | null };

/**
 * Coaching: a player who is out of the match (eliminated, or spectating a
 * match they joined late) proposes where a live player should drop their
 * current piece. Purely advisory and never authoritative: it travels on the
 * droppable `viz` channel, never enters the log, and a player who follows it
 * still submits an ordinary Placement that the host validates as usual.
 */
export interface Suggestion {
  matchId: string;
  /** Coach (sender). */
  from: string;
  /** Player being coached. */
  to: string;
  /** The coached player's piece index this suggestion is for. */
  idx: number;
  /** Swap with the hold piece first. */
  usedHold: boolean;
  /** Final resting position (a hard-drop position). */
  piece: PiecePos;
  at: number;
}

/** Callout codes are opaque short ids; the presentation layer owns their wording. */
export const CALLOUT_CODE_RE = /^[a-z]{1,12}$/;
const CALLOUT_GAP_MS = 900;
const SUGGESTION_TTL_MS = 20_000;
/** Falling-piece updates: at most one per this many ms (20 Hz). */
const LIVE_INTERVAL_MS = 50;

export interface CoordinatorOptions {
  mesh: Mesh;
  clock: Clock;
  name: string;
  cosmetics?: Cosmetics;
  /** True for the room creator, who bootstraps epoch 1 as host. */
  create: boolean;
  /**
   * For the room's creator coming back (page reload, reopened link): if no
   * peer with an active room shows up within this many ms, recreate the room
   * as host instead of waiting forever for a host that no longer exists.
   */
  hostIfAloneAfterMs?: number;
  config?: Partial<CoordinatorConfig>;
  rules?: Partial<Rules>;
}

export interface CoordinatorStats {
  staleRejected: number;
  invalid: number;
  elections: number;
  syncsAdopted: number;
  placeRejected: number;
}

interface Candidacy {
  epoch: number;
  phase: "pre" | "vote";
  grants: Set<string>;
  votes: Map<string, unknown>;
  deadline: number;
}

interface LocalPlayer {
  matchId: string;
  sim: PlayerSim;
  pending: Placement[];
  consumed: Set<string>;
  hashAt: Map<number, number>;
}

/** r: the sender's round-trip time to its host in ms (null if it is the host or hasn't measured yet). */
type HeartbeatPayload = { e: number; h: string | null; s: number; c: number; r: number | null };
const REPORTED_RTT_TTL_MS = 4000;

/**
 * Match coordinator: one per peer. Owns host election, host authority, the
 * replicated log, recovery and the local player's optimistic simulation.
 *
 * Protocol summary (see ARCHITECTURE.md for the full argument):
 *  - The host appends entries to a log; followers apply them in order.
 *  - Every authoritative message carries (epoch, hostId, seq, msg id, matchId).
 *  - Followers reject anything from an older epoch.
 *  - Host loss -> pre-vote -> vote, staggered by deterministic roster priority.
 *  - During a match a candidate needs a majority of the voting members, and
 *    every vote carries the voter's checkpoint + log, so the winner rebuilds
 *    from the most up-to-date state any member of the quorum has. Entries that
 *    were committed (acked by a majority) are therefore never lost.
 *  - A host that cannot hear a majority steps down, so a minority partition
 *    can never keep playing or declare a winner.
 */
export class Coordinator {
  readonly playerId: string;
  readonly mesh: Mesh;
  private readonly clock: Clock;
  private readonly cfg: CoordinatorConfig;
  private readonly rules: Rules;
  private readonly events = new Emitter<{ event: (e: CoordinatorEvent) => void; change: () => void }>();
  readonly stats: CoordinatorStats = { staleRejected: 0, invalid: 0, elections: 0, syncsAdopted: 0, placeRejected: 0 };

  private name: string;
  private cosmetics: Cosmetics;
  private mode: NodeMode;
  private epoch = 0;
  private hostId: string | null = null;
  private formerHost: string | null = null;
  private votedFor = new Map<number, string>();
  private log: ReplicatedLog | null = null;
  private commit = 0;
  private hostLastHeard = 0;
  private leaderlessSince = 0;
  private nextCandidacyAt = 0;
  private electionAttempt = 0;
  private candidate: Candidacy | null = null;
  private recentCandidates = new Map<string, number>();
  private departed = new Set<string>();
  private resumeAt = 0;
  private abandoned = false;
  private rejectedReason: string | null = null;
  private lastSyncReq = new Map<string, number>();
  private lastJoinSent = 0;
  private hostIfAloneAfterMs: number | null = null;
  /** Last time any peer advertised an active room (epoch > 0) in a heartbeat. */
  private roomSeenAt = -Infinity;
  private joinStartedAt = 0;
  private ackDue = false;

  // host-only
  private acks = new Map<string, number>();
  private epochStartSeq = 0;
  private disconnectedSince = new Map<string, number>();
  private goAt: number | null = null;
  private clockBase = 0;
  private clockStart = 0;

  // local player
  private local: LocalPlayer | null = null;
  private placeSeq = new Map<number, number>();
  private matchEndSeq = Infinity;
  private lastMembershipSeq = 0;
  private livePiece: { piece: PiecePos; idx: number; dirty: boolean; at: number } | null = null;
  private liveFlush: TimerHandle | null = null;
  /** Sequence number for our live messages: the live channel may reorder, so receivers keep only the newest. */
  private liveSeq = 0;
  readonly remotePieces = new Map<string, { piece: PiecePos; idx: number; at: number; q: number }>();
  /**
   * Pieces opponents have just locked, sent straight to everyone so their
   * boards update after one hop instead of waiting for the host's log entry
   * (two hops). Display-only: the log stays the truth and replaces it.
   */
  readonly remoteLocks = new Map<string, { piece: PiecePos; idx: number; at: number }>();
  /** Coaching suggestions, keyed by coached player, then by coach. Only the latest per coach is kept. */
  private readonly suggestions = new Map<string, Map<string, Suggestion>>();
  private readonly lastCalloutFrom = new Map<string, number>();
  private lastCalloutSent = -Infinity;
  /** Each peer's self-reported ping to the host, from heartbeats. */
  private readonly reportedRtt = new Map<string, { ms: number; at: number }>();

  private readonly timer: number;
  private readonly unsub: (() => void)[] = [];

  constructor(opts: CoordinatorOptions) {
    this.mesh = opts.mesh;
    this.playerId = opts.mesh.playerId;
    this.clock = opts.clock;
    this.cfg = { ...DEFAULT_CONFIG, ...opts.config };
    this.rules = { ...DEFAULT_RULES, ...opts.rules };
    this.name = cleanName(opts.name) ?? "Player";
    this.cosmetics = opts.cosmetics ?? {};
    this.mode = opts.create ? "host" : "joining";

    this.unsub.push(
      this.mesh.on("message", (m) => this.onMessage(m)),
      this.mesh.on("peerUp", (p) => this.onPeerUp(p)),
      this.mesh.on("peerDown", (p, r) => this.onPeerDown(p, r)),
      this.mesh.on("heartbeat", (p, hb) => this.onHeartbeat(p, hb)),
      this.mesh.on("rejected", (_t, reason) => {
        // A reloaded tab is briefly "duplicate" until its old connection times out; only give up if it persists.
        if (reason === "duplicate-identity" && this.mode === "joining" && this.clock.now() - this.joinStartedAt > 20_000)
          this.reject("duplicate-identity");
      }),
    );
    // Mesh heartbeats carry our view of the election state.
    this.mesh.setHeartbeatProvider(() => this.heartbeatPayload());

    this.hostIfAloneAfterMs = opts.hostIfAloneAfterMs ?? null;
    if (opts.create) this.bootstrapAsHost();
    else {
      this.joinStartedAt = this.clock.now();
      this.sendJoin();
    }
    this.timer = this.clock.setInterval(() => this.tick(), this.cfg.tickMs);
  }

  /** Start a brand-new room log at epoch 1 with ourselves as the only member and host. */
  private bootstrapAsHost(): void {
    this.log = ReplicatedLog.fresh(this.rules);
    this.mode = "host";
    this.epoch = 1;
    this.votedFor.set(1, this.playerId);
    this.hostId = this.playerId;
    this.epochStartSeq = 1;
    this.hostAppend([{ k: "join", playerId: this.playerId, name: this.name, cosmetics: this.cosmetics }]);
  }

  // ================================================================ public API

  on(handler: (e: CoordinatorEvent) => void): () => void {
    return this.events.on("event", handler);
  }

  onChange(handler: () => void): () => void {
    return this.events.on("change", handler);
  }

  /** @internal Test/diagnostics access to the local log copy. */
  get debugLog(): ReplicatedLog | null {
    return this.log;
  }

  get state(): RoomState | null {
    return this.log?.state ?? null;
  }

  view() {
    const now = this.clock.now();
    const st = this.log?.state ?? null;
    const migrating = this.mode === "leaderless" || this.mode === "candidate";
    const phase = st?.phase ?? "lobby";
    return {
      playerId: this.playerId,
      mode: this.mode,
      epoch: this.epoch,
      hostId: this.hostId,
      isHost: this.mode === "host",
      state: st,
      phase,
      migrating,
      abandoned: this.abandoned,
      paused: migrating || this.mode === "joining" || now < this.resumeAt || phase !== "playing" || this.abandoned,
      resumeInMs: Math.max(0, this.resumeAt - now),
      commit: this.commit,
      lastSeq: this.log?.lastSeq ?? 0,
      rejectedReason: this.rejectedReason,
      localSim: this.local?.sim ?? null,
      matchEndCommitted: this.isMatchEndCommitted(),
      joinWaitMs: this.mode === "joining" ? now - this.joinStartedAt : 0,
    };
  }

  /** Garbage the host has ordered us to absorb that we have not inserted yet. */
  pendingGarbageForMe(): GarbageChunk[] {
    const mp = this.log?.state.match?.players[this.playerId];
    if (!mp || !this.local) return [];
    return mp.commanded.filter((c) => !this.local!.consumed.has(c.id));
  }

  incomingLinesForMe(): number {
    const mp = this.log?.state.match?.players[this.playerId];
    if (!mp) return 0;
    return mp.incoming.reduce((a, g) => a + g.lines, 0) + this.pendingGarbageForMe().reduce((a, g) => a + g.lines, 0);
  }

  setReady(ready: boolean): void {
    this.intent({ k: "ready", playerId: this.playerId, ready }, { op: "ready", v: ready });
  }

  setTarget(mode: TargetMode, target: string | null = null): void {
    this.intent({ k: "target", playerId: this.playerId, mode, target }, { op: "target", mode, target });
  }

  setCosmetics(cosmetics: Cosmetics): void {
    if (!isCosmetics(cosmetics)) return;
    this.cosmetics = cosmetics;
    this.intent({ k: "cosmetics", playerId: this.playerId, cosmetics }, { op: "cos", cos: cosmetics });
  }

  /** Host only, lobby only: change the room's match options (bombs etc.). */
  setOptions(options: MatchOptions): boolean {
    if (this.mode !== "host" || this.log?.state.phase !== "lobby" || !isMatchOptions(options)) return false;
    return this.hostAppend([{ k: "options", options: { ...options } }]).length === 1;
  }

  canStart(): { ok: boolean; reason?: string } {
    const st = this.log?.state;
    if (this.mode !== "host" || !st) return { ok: false, reason: "Only the host can start" };
    if (st.phase !== "lobby") return { ok: false, reason: "Not in lobby" };
    const players = st.roster.filter((r) => r.role === "player");
    if (players.length < MIN_PLAYERS) return { ok: false, reason: `Need at least ${MIN_PLAYERS} players` };
    if (players.some((r) => !r.connected)) return { ok: false, reason: "Waiting for a player to reconnect" };
    if (players.some((r) => r.playerId !== this.playerId && !r.ready)) return { ok: false, reason: "Waiting for everyone to ready up" };
    return { ok: true };
  }

  startMatch(): boolean {
    if (!this.canStart().ok || !this.log) return false;
    const seed = new DataView(randomBytes(4).buffer).getUint32(0);
    const matchId = `m${this.log.state.matchCounter + 1}-${seed.toString(36)}`;
    const ok = this.hostAppend([{ k: "start", matchId, seed }]).length === 1;
    if (ok) this.goAt = this.clock.now() + this.cfg.countdownMs;
    return ok;
  }

  rematch(): boolean {
    if (this.mode !== "host" || this.log?.state.phase !== "ended") return false;
    return this.hostAppend([{ k: "rematch" }]).length === 1;
  }

  closeRoom(): void {
    if (this.mode === "host") this.hostAppend([{ k: "close" }]);
    this.leave();
  }

  leave(): void {
    if (this.mode === "left") return;
    this.mesh.send("crit", "leaving", {});
    this.mode = "left";
    this.changed();
    this.clock.setTimeout(() => void this.destroy(), 150);
  }

  async destroy(): Promise<void> {
    this.clock.clearInterval(this.timer);
    if (this.liveFlush !== null) this.clock.clearTimeout(this.liveFlush);
    for (const u of this.unsub) u();
    await this.mesh.close();
  }

  /**
   * Called by the presentation layer when the local controller locks a piece.
   * Applies it optimistically and sends it to the host for validation.
   */
  submitPlacement(p: Placement): LockResult | null {
    const v = this.view();
    const st = this.log?.state;
    if (!this.local || !st?.match || v.paused || st.match.matchId !== this.local.matchId) return null;
    const chunks = this.pendingGarbageForMe();
    const pl: Placement = { ...p, pieceIndex: this.local.sim.s.piecesPlaced, garbageIds: chunks.map((c) => c.id) };
    const out = this.local.sim.applyPlacement(pl, chunks);
    if (!out.ok) {
      this.resyncLocal(`local-${out.error}`);
      return null;
    }
    for (const c of chunks) this.local.consumed.add(c.id);
    this.local.pending.push(pl);
    this.local.hashAt.set(this.local.sim.s.piecesPlaced, this.local.sim.hash());
    this.sendPlace(pl);
    // Show the lock on everyone's screen now; the host's log entry follows a hop later.
    this.sendLive(pl.pieceIndex, { type: pl.type, x: pl.x, y: pl.y, rot: pl.rot }, true);
    this.changed();
    return out.result;
  }

  /**
   * Latest falling-piece position, broadcast to opponents on the live channel
   * at up to 20 Hz. Sent as soon as the rate allows (not on the 100 ms tick),
   * with a trailing send so the final position always goes out.
   */
  publishLivePiece(piece: PiecePos): void {
    if (!this.local) return;
    const idx = this.local.sim.s.piecesPlaced;
    const lp = this.livePiece;
    if (lp && lp.idx === idx && lp.piece.x === piece.x && lp.piece.y === piece.y && lp.piece.rot === piece.rot && lp.piece.type === piece.type) return;
    this.livePiece = { piece: { ...piece }, idx, dirty: true, at: lp?.at ?? -Infinity };
    this.flushLive();
  }

  private flushLive(): void {
    const lp = this.livePiece;
    if (!lp?.dirty || !this.local || this.mode === "left") return;
    const now = this.clock.now();
    const wait = lp.at + LIVE_INTERVAL_MS - now;
    // A new piece goes out at once: it's what makes the previous lock visible.
    const newPiece = this.lastLiveIdx !== lp.idx;
    if (wait > 0 && !newPiece) {
      this.liveFlush ??= this.clock.setTimeout(() => {
        this.liveFlush = null;
        this.flushLive();
      }, wait);
      return;
    }
    lp.dirty = false;
    lp.at = now;
    this.sendLive(lp.idx, lp.piece, false);
  }

  private lastLiveIdx = -1;

  private sendLive(idx: number, piece: PiecePos, locked: boolean): void {
    if (!this.local) return;
    if (!locked) this.lastLiveIdx = idx;
    const payload: Record<string, unknown> = { mid: this.local.matchId, i: idx, q: ++this.liveSeq, p: { t: piece.type, x: piece.x, y: piece.y, r: piece.rot } };
    if (locked) payload.k = 1;
    this.send("live", payload, undefined, "live");
  }

  private onLive(from: string, p: Record<string, unknown>): void {
    const m = this.log?.state.match;
    const pc = p.p;
    if (!m || p.mid !== m.matchId || !m.players[from]) return;
    if (!isInt(p.i, 0, 1e6) || !isObj(pc) || !isPieceType(pc.t) || !isInt(pc.x, -4, 13) || !isInt(pc.y, -4, 44) || !isInt(pc.r, 0, 3)) return void this.stats.invalid++;
    const piece: PiecePos = { type: pc.t, x: pc.x, y: pc.y, rot: pc.r as PiecePos["rot"] };
    const now = this.clock.now();
    if (p.k === 1) {
      const prev = this.remoteLocks.get(from);
      if (!prev || p.i >= prev.idx) this.remoteLocks.set(from, { piece, idx: p.i, at: now });
      return;
    }
    // Unordered delivery: drop anything older than what we already have (a reloaded sender restarts q, so accept it once ours is stale).
    const q = isInt(p.q, 0, Number.MAX_SAFE_INTEGER) ? p.q : 0;
    const prev = this.remotePieces.get(from);
    if (prev && now - prev.at < 1000 && (p.i < prev.idx || (p.i === prev.idx && q <= prev.q))) return;
    this.remotePieces.set(from, { piece, idx: p.i, at: now, q });
  }

  // ============================================================ coaching

  /** Can `coach` send placement suggestions to `player` right now? Coaches are room members who are out of the match. */
  canCoach(player: string, coach: string = this.playerId): boolean {
    const st = this.log?.state;
    const m = st?.match;
    if (!st || !m || st.phase !== "playing" || coach === player) return false;
    if (!m.players[player]?.alive) return false;
    if (!findRoster(st, coach)) return false;
    return !m.players[coach]?.alive;
  }

  /**
   * Suggest where `player` should drop piece number `idx`. Broadcast to the
   * whole room so other coaches see it too. Returns false if not allowed.
   */
  suggestPlacement(player: string, s: { idx: number; usedHold: boolean; piece: PiecePos }): boolean {
    const m = this.log?.state.match;
    if (!m || !this.canCoach(player)) return false;
    const sug: Suggestion = { matchId: m.matchId, from: this.playerId, to: player, idx: s.idx, usedHold: s.usedHold, piece: { ...s.piece }, at: this.clock.now() };
    this.storeSuggestion(sug);
    const p = sug.piece;
    this.send("sug", { mid: m.matchId, to: player, i: s.idx, h: s.usedHold, p: { t: p.type, x: p.x, y: p.y, r: p.rot } }, undefined, "viz");
    this.changed();
    return true;
  }

  /** Live suggestions for `player`'s current piece, newest first. */
  suggestionsFor(player: string): Suggestion[] {
    const st = this.log?.state;
    const m = st?.match;
    const byCoach = this.suggestions.get(player);
    if (!st || !m || st.phase !== "playing" || !byCoach) return [];
    const placed = player === this.playerId && this.local ? this.local.sim.s.piecesPlaced : m.players[player]?.sim.s.piecesPlaced ?? Infinity;
    const now = this.clock.now();
    const out: Suggestion[] = [];
    for (const [coach, s] of byCoach) {
      if (s.matchId !== m.matchId || s.idx < placed || now - s.at > SUGGESTION_TTL_MS) byCoach.delete(coach);
      else if (s.idx === placed) out.push(s);
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** Tell the room we followed a coach's suggestion (credit where it's due). */
  tookSuggestion(coach: string): void {
    const m = this.log?.state.match;
    if (!m || !isPid(coach)) return;
    this.send("sug_ok", { mid: m.matchId, c: coach }, undefined, "viz");
    this.events.emit("event", { kind: "suggestion-taken", player: this.playerId, coach });
  }

  /**
   * Quick callout to the whole room (e.g. "nice", "help"). `about` optionally
   * names another participant. Locally throttled; receivers throttle too.
   */
  sendCallout(code: string, about: string | null = null): boolean {
    const st = this.log?.state;
    const m = st?.match;
    if (!st || !m || (st.phase !== "playing" && st.phase !== "countdown") || !CALLOUT_CODE_RE.test(code)) return false;
    if (about !== null && !m.participants.includes(about)) return false;
    const now = this.clock.now();
    if (now - this.lastCalloutSent < CALLOUT_GAP_MS) return false;
    this.lastCalloutSent = now;
    this.send("call", { mid: m.matchId, c: code, a: about }, undefined, "viz");
    this.events.emit("event", { kind: "callout", from: this.playerId, code, about });
    return true;
  }

  private storeSuggestion(s: Suggestion): void {
    let byCoach = this.suggestions.get(s.to);
    if (!byCoach) this.suggestions.set(s.to, (byCoach = new Map()));
    byCoach.set(s.from, s);
  }

  private onSuggestion(from: string, p: Record<string, unknown>): void {
    const m = this.log?.state.match;
    const pc = p.p;
    if (!m || p.mid !== m.matchId || !isPid(p.to) || !isInt(p.i, 0, 1e6) || !isBool(p.h)) return;
    if (!isObj(pc) || !isPieceType(pc.t) || !isInt(pc.x, -4, 13) || !isInt(pc.y, -4, 44) || !isInt(pc.r, 0, 3)) return void this.stats.invalid++;
    if (!this.canCoach(p.to, from)) return;
    const sug: Suggestion = { matchId: m.matchId, from, to: p.to, idx: p.i, usedHold: p.h, piece: { type: pc.t, x: pc.x, y: pc.y, rot: pc.r as PiecePos["rot"] }, at: this.clock.now() };
    this.storeSuggestion(sug);
    this.events.emit("event", { kind: "suggestion", suggestion: sug });
    if (sug.to === this.playerId) this.changed();
  }

  private onSuggestionTaken(from: string, p: Record<string, unknown>): void {
    const m = this.log?.state.match;
    if (!m || p.mid !== m.matchId || !isPid(p.c) || !m.players[from]) return;
    this.events.emit("event", { kind: "suggestion-taken", player: from, coach: p.c });
  }

  private onCallout(from: string, p: Record<string, unknown>): void {
    const st = this.log?.state;
    const m = st?.match;
    if (!st || !m || p.mid !== m.matchId || !isStr(p.c, 12) || !CALLOUT_CODE_RE.test(p.c) || !findRoster(st, from)) return;
    const about = p.a === null || p.a === undefined ? null : isPid(p.a) && m.participants.includes(p.a) ? p.a : undefined;
    if (about === undefined) return void this.stats.invalid++;
    const now = this.clock.now();
    if (now - (this.lastCalloutFrom.get(from) ?? -Infinity) < CALLOUT_GAP_MS * 0.8) return;
    this.lastCalloutFrom.set(from, now);
    this.events.emit("event", { kind: "callout", from, code: p.c, about });
  }

  // ============================================================ messaging

  private onMessage(m: MeshMessage): void {
    if (this.mode === "left") return;
    const p = m.payload;
    if (!isObj(p)) return void this.stats.invalid++;
    switch (m.type) {
      case "join":
        return this.onJoin(m.from, p);
      case "join_rej":
        if (isStr(p.reason, 32) && this.mode === "joining") this.reject(p.reason);
        return;
      case "leaving":
        return this.onLeaving(m.from);
      case "place":
        if (!isStr(p.mid, 48) || !isPlacement(p.pl)) return void this.stats.invalid++;
        return this.hostHandlePlace(m.from, p.mid, p.pl);
      case "place_rej":
        if (m.from === this.hostId && isStr(p.mid, 48) && this.local?.matchId === p.mid) {
          this.stats.placeRejected++;
          this.resyncLocal(`host-rejected:${String(p.reason).slice(0, 32)}`);
        }
        return;
      case "ctl":
        return this.onCtl(m.from, p);
      case "log":
        return this.onLog(m.from, p);
      case "sync":
        return this.onSync(m.from, p);
      case "sync_req":
        return this.onSyncReq(m.from);
      case "prevote":
        return this.onPrevote(m.from, p);
      case "prevote_r":
        return this.onPrevoteReply(m.from, p);
      case "vote_req":
        return this.onVoteReq(m.from, p);
      case "vote":
        return this.onVote(m.from, p);
      case "ack":
        if (this.mode === "host" && p.e === this.epoch && isInt(p.s, 0, Number.MAX_SAFE_INTEGER)) {
          this.acks.set(m.from, Math.max(this.acks.get(m.from) ?? 0, p.s));
          this.updateCommit();
        }
        return;
      case "live":
        return this.onLive(m.from, p);
      case "sug":
        return this.onSuggestion(m.from, p);
      case "sug_ok":
        return this.onSuggestionTaken(m.from, p);
      case "call":
        return this.onCallout(m.from, p);
      default:
        this.stats.invalid++;
    }
  }

  private send(type: string, payload: unknown, to?: string | string[], channel: "crit" | "state" | "viz" | "live" = "crit"): void {
    this.mesh.send(channel, type, payload, to);
  }

  private heartbeatPayload(): HeartbeatPayload {
    const toHost = this.mode !== "host" && this.hostId ? this.mesh.rtt(this.hostId) : null;
    return { e: this.epoch, h: this.mode === "host" ? this.playerId : this.hostId, s: this.log?.lastSeq ?? 0, c: this.commit, r: toHost === null ? null : Math.round(toHost) };
  }

  /**
   * A player's ping to the current host in ms: 0 for the host itself, null if
   * unknown. This is the delay that matters for fairness here: placements are
   * validated, and garbage is timed, by the host.
   */
  pingToHost(pid: string): number | null {
    const host = this.mode === "host" ? this.playerId : this.hostId;
    if (!host) return null;
    if (pid === host) return 0;
    if (pid === this.playerId || host === this.playerId) {
      const ms = this.mesh.rtt(pid === this.playerId ? host : pid);
      return ms === null ? null : Math.round(ms);
    }
    const r = this.reportedRtt.get(pid);
    return r && this.mesh.isConnected(pid) && this.clock.now() - r.at < REPORTED_RTT_TTL_MS ? r.ms : null;
  }

  private onHeartbeat(from: string, raw: unknown): void {
    if (this.mode === "left" || !isObj(raw)) return;
    const e = raw.e, h = raw.h, s = raw.s;
    if (!isInt(e, 0, Number.MAX_SAFE_INTEGER) || !isInt(s, 0, Number.MAX_SAFE_INTEGER) || !(h === null || isPid(h))) return;
    if (isInt(raw.r, 0, 60_000)) this.reportedRtt.set(from, { ms: raw.r, at: this.clock.now() });
    if (this.mode === "host" && e === this.epoch) {
      this.acks.set(from, Math.max(this.acks.get(from) ?? 0, s));
      this.updateCommit();
    }
    const claimsHost = h === from;
    // Only a live host counts: a peer stuck leaderless (e.g. the one friend left
    // in a 2-player lobby) can never elect itself, so we must re-host for it.
    if (e > 0 && claimsHost) this.roomSeenAt = this.clock.now();
    if (this.mode === "joining") {
      if (claimsHost) this.sendJoin(from);
      return;
    }
    if (!claimsHost) {
      // Keep terms aligned while nobody is host (Raft term propagation).
      if ((this.mode === "leaderless") && e > this.epoch) this.epoch = e;
      return;
    }
    if (e > this.epoch) {
      if (this.mode === "host") this.stepDown("higher-epoch");
      this.requestSync(from);
    } else if (e === this.epoch) {
      if (this.hostId === from) {
        this.hostLastHeard = this.clock.now();
        const c = raw.c;
        if (this.mode === "follower" && this.log && isInt(c, 0, Number.MAX_SAFE_INTEGER) && c > this.commit) {
          this.commit = Math.min(c, this.log.lastSeq);
          this.log.maybeCheckpoint(this.commit, this.cfg.checkpointEvery);
          this.prunePending();
          this.changed();
        }
      }
      else if (this.mode === "host") this.resolveDualHost(from);
      else if (this.mode === "leaderless" || (this.mode === "candidate" && this.candidate?.phase === "pre")) this.requestSync(from);
    }
  }

  // ============================================================ peers

  private onPeerUp(pid: string): void {
    this.events.emit("event", { kind: "peer", playerId: pid, up: true });
    if (this.mode === "joining") this.sendJoin(pid);
    if (this.mode === "host" && this.log) {
      const r = findRoster(this.log.state, pid);
      if (r && !this.departed.has(pid)) {
        if (!r.connected) this.hostAppend([{ k: "presence", playerId: pid, connected: true }]);
        this.disconnectedSince.delete(pid);
        this.sendSync(pid);
      }
    }
    this.changed();
  }

  private onPeerDown(pid: string, reason: string): void {
    this.events.emit("event", { kind: "peer", playerId: pid, up: false });
    if (pid === this.hostId && this.mode === "follower") this.enterLeaderless(`host-${reason}`);
    if (this.mode === "host" && this.log) {
      const r = findRoster(this.log.state, pid);
      if (r?.connected) {
        this.hostAppend([{ k: "presence", playerId: pid, connected: false }]);
        this.disconnectedSince.set(pid, this.clock.now());
      }
    }
    this.changed();
  }

  private onLeaving(pid: string): void {
    this.departed.add(pid);
    if (pid === this.hostId && this.mode === "follower") this.enterLeaderless("host-left");
    if (this.mode === "host") this.hostTick(this.clock.now());
    this.changed();
  }

  // ============================================================ joining

  private sendJoin(to?: string): void {
    const now = this.clock.now();
    if (to === undefined && now - this.lastJoinSent < 1500) return;
    this.lastJoinSent = now;
    this.send("join", { name: this.name, cos: this.cosmetics }, to);
  }

  private reject(reason: string): void {
    this.mode = "rejected";
    this.rejectedReason = reason;
    this.events.emit("event", { kind: "rejected", reason });
    this.changed();
  }

  private onJoin(from: string, p: Record<string, unknown>): void {
    if (this.mode !== "host" || !this.log) return;
    const name = cleanName(p.name);
    const cosmetics = isCosmetics(p.cos) ? p.cos : {};
    if (!name) return void this.stats.invalid++;
    const st = this.log.state;
    if (st.closed) return this.send("join_rej", { reason: "closed" }, from);
    this.departed.delete(from);
    const existing = findRoster(st, from);
    if (!existing && st.roster.length >= 6) return this.send("join_rej", { reason: "full" }, from);
    if (!existing && !this.membershipChangeAllowed()) return; // joiner retries shortly
    const applied = this.hostAppend([{ k: "join", playerId: from, name, cosmetics }]);
    if (applied.length === 0) return this.send("join_rej", { reason: "full" }, from);
    this.disconnectedSince.delete(from);
    this.sendSync(from);
  }

  // ============================================================ host

  private intent(body: EntryBody, ctl: Record<string, unknown>): void {
    if (this.mode === "host") this.hostAppend([body]);
    else if (this.hostId) this.send("ctl", ctl, this.hostId);
  }

  private onCtl(from: string, p: Record<string, unknown>): void {
    if (this.mode !== "host" || !this.log || !findRoster(this.log.state, from)) return;
    switch (p.op) {
      case "ready":
        if (isBool(p.v)) this.hostAppend([{ k: "ready", playerId: from, ready: p.v }]);
        return;
      case "target":
        if ((p.mode === "random" || p.mode === "manual" || p.mode === "revenge") && (p.target === null || isPid(p.target)))
          this.hostAppend([{ k: "target", playerId: from, mode: p.mode, target: p.target }]);
        return;
      case "cos":
        if (isCosmetics(p.cos)) this.hostAppend([{ k: "cosmetics", playerId: from, cosmetics: p.cos }]);
        return;
      default:
        this.stats.invalid++;
    }
  }

  private matchClock(): number {
    const m = this.log?.state.match;
    if (!m) return 0;
    if (this.log!.state.phase !== "playing") return m.elapsedMs;
    return Math.max(m.elapsedMs, this.clockBase + Math.max(0, this.clock.now() - this.clockStart));
  }

  private hostHandlePlace(from: string, mid: string, pl: Placement): void {
    if (this.mode !== "host" || !this.log) return;
    const st = this.log.state;
    const m = st.match;
    if (!m || m.matchId !== mid || st.phase !== "playing") return;
    const mp = m.players[from];
    if (!mp || !mp.alive) return;
    if (pl.pieceIndex < mp.sim.s.piecesPlaced) return; // duplicate (e.g. resent after migration)
    const body: EntryBody = { k: "place", playerId: from, t: this.matchClock(), pl };
    const entry = { ...body, seq: this.log.lastSeq + 1, epoch: this.epoch } as LogEntry;
    const r = this.log.apply(entry);
    if (!r.ok) {
      this.stats.placeRejected++;
      if (from === this.playerId) this.resyncLocal(`host-rejected:${r.error}`);
      else this.send("place_rej", { mid, idx: pl.pieceIndex, reason: r.error }, from);
      return;
    }
    this.afterHostApply([entry], [r.effects]);
  }

  /** Append entries as host. Returns the entries that applied. */
  private hostAppend(bodies: EntryBody[]): LogEntry[] {
    if (this.mode !== "host" || !this.log) return [];
    const applied: LogEntry[] = [];
    const effects: Effect[][] = [];
    for (const b of bodies) {
      const entry = { ...b, seq: this.log.lastSeq + 1, epoch: this.epoch } as LogEntry;
      const r = this.log.apply(entry);
      if (r.ok) {
        applied.push(entry);
        effects.push(r.effects);
      }
    }
    if (applied.length) this.afterHostApply(applied, effects);
    return applied;
  }

  private afterHostApply(entries: LogEntry[], effects: Effect[][]): void {
    const st = this.log!.state;
    entries.forEach((e, i) => {
      this.trackPlace(e);
      this.handleEffects(effects[i]!, e.seq);
    });
    this.updateCommit();
    this.send("log", { e: this.epoch, h: this.playerId, mid: st.match?.matchId ?? null, en: entries, c: this.commit });
    this.reconcileLocal(false);
    this.changed();
  }

  private sendSync(to?: string | string[]): void {
    if (this.mode !== "host" || !this.log) return;
    const resume = Math.max(0, this.resumeAt - this.clock.now());
    this.send("sync", { e: this.epoch, h: this.playerId, x: this.log.export(), c: this.commit, resume }, to);
  }

  private onSyncReq(from: string): void {
    // Any authenticated peer (it proved it holds the room key) may fetch state.
    // A non-member then sees it isn't on the roster and asks to join; this is
    // how a peer stranded in an old copy of the room finds a recreated one.
    if (this.mode !== "host" || !this.log) return;
    this.sendSync(from);
  }

  private members(): string[] {
    const st = this.log?.state;
    if (!st) return [];
    return st.roster.map((r) => r.playerId).filter((p) => !this.departed.has(p));
  }

  /**
   * Majority of voting members, in EVERY phase. (A lobby-only quorum of 1 looks
   * harmless but lets a lone host "commit" the entry that ends a match, because
   * that entry flips the phase to "ended". Found by the chaos test.)
   */
  private quorum(): number {
    return Math.floor(Math.max(1, this.members().length) / 2) + 1;
  }

  /**
   * Raft single-server membership rule: a join/leave may only be appended once
   * the previous membership change is committed, so a minority host can never
   * shrink the roster until it looks like a majority.
   */
  private membershipChangeAllowed(): boolean {
    return this.commit >= this.lastMembershipSeq;
  }

  private isUp(pid: string): boolean {
    return pid === this.playerId || this.mesh.isConnected(pid);
  }

  private updateCommit(): void {
    if (this.mode !== "host" || !this.log) return;
    const last = this.log.lastSeq;
    const members = this.members();
    const q = this.quorum();
    let candidate: number;
    if (q <= 1) candidate = last;
    else {
      const acked = members.map((p) => (p === this.playerId ? last : Math.min(last, this.acks.get(p) ?? 0))).sort((a, b) => b - a);
      candidate = acked[q - 1] ?? 0;
    }
    // Only entries from our own epoch commit by counting (Raft §5.4.2); older ones commit with them.
    if (candidate >= this.epochStartSeq && candidate > this.commit) {
      this.commit = candidate;
      this.log.maybeCheckpoint(this.commit, this.cfg.checkpointEvery);
      this.prunePending();
      this.changed();
    }
  }

  private resolveDualHost(other: string): void {
    // Two hosts in the same epoch can only arise in lobby phases (quorum of 1).
    const order = this.priorityOrder();
    if (order.indexOf(this.playerId) < order.indexOf(other) || !order.includes(other)) {
      this.epoch++;
      this.votedFor.set(this.epoch, this.playerId);
      this.epochStartSeq = (this.log?.lastSeq ?? 0) + 1;
      this.hostAppend([{ k: "noop" }]);
      this.sendSync();
    }
  }

  private stepDown(reason: string): void {
    if (this.mode !== "host") return;
    this.formerHost = null;
    this.hostId = null;
    this.goAt = null;
    this.mode = "leaderless";
    this.leaderlessSince = this.clock.now();
    this.electionAttempt = 0;
    this.computeNextCandidacy();
    this.events.emit("event", { kind: "migration-start", formerHost: this.playerId, reason });
    this.changed();
  }

  // ============================================================ follower

  private requestSync(from: string): void {
    const now = this.clock.now();
    if (now - (this.lastSyncReq.get(from) ?? -Infinity) < 1000) return;
    this.lastSyncReq.set(from, now);
    this.send("sync_req", { e: this.epoch }, from);
  }

  private onLog(from: string, p: Record<string, unknown>): void {
    const e = p.e;
    if (!isInt(e, 0, Number.MAX_SAFE_INTEGER) || p.h !== from || !Array.isArray(p.en) || !isInt(p.c, 0, Number.MAX_SAFE_INTEGER))
      return void this.stats.invalid++;
    if (e < this.epoch) {
      this.stats.staleRejected++;
      return;
    }
    if (this.mode !== "follower" || from !== this.hostId || e !== this.epoch || !this.log) {
      if (this.mode !== "host" || e > this.epoch) this.requestSync(from);
      return;
    }
    this.hostLastHeard = this.clock.now();
    for (const raw of p.en) {
      if (!isLogEntry(raw)) {
        this.stats.invalid++;
        this.requestSync(from);
        break;
      }
      if (raw.seq <= this.log.lastSeq) continue;
      if (raw.seq !== this.log.lastSeq + 1 || raw.epoch !== this.epoch) {
        this.requestSync(from);
        break;
      }
      const r = this.log.apply(raw);
      if (!r.ok) {
        this.stats.invalid++;
        this.requestSync(from);
        break;
      }
      this.trackPlace(raw);
      this.handleEffects(r.effects, raw.seq);
    }
    this.commit = Math.max(this.commit, Math.min(p.c, this.log.lastSeq));
    this.log.maybeCheckpoint(this.commit, this.cfg.checkpointEvery);
    this.ackDue = true;
    this.prunePending();
    this.reconcileLocal(false);
    this.changed();
  }

  private onSync(from: string, p: Record<string, unknown>): void {
    const e = p.e;
    if (!isInt(e, 0, Number.MAX_SAFE_INTEGER) || p.h !== from || !isInt(p.c, 0, Number.MAX_SAFE_INTEGER)) return void this.stats.invalid++;
    if (this.mode === "left" || this.mode === "rejected") return;
    const sameEpochOk =
      e === this.epoch &&
      (this.hostId === from || this.formerHost === from || this.votedFor.get(e) === from || this.mode === "joining" || (this.mode !== "host" && this.hostId === null));
    if (e < this.epoch || (e === this.epoch && !sameEpochOk)) {
      if (e < this.epoch) this.stats.staleRejected++;
      return;
    }
    let log: ReplicatedLog;
    try {
      log = ReplicatedLog.fromExport(p.x, this.rules);
    } catch {
      this.stats.invalid++;
      return;
    }
    const wasHost = this.mode === "host";
    const prevHost = this.hostId;
    this.log = log;
    this.epoch = e;
    this.votedFor.set(e, from);
    this.hostId = from;
    this.formerHost = null;
    this.mode = findRoster(log.state, this.playerId) ? "follower" : "joining";
    this.hostLastHeard = this.clock.now();
    this.commit = Math.min(p.c, log.lastSeq);
    this.candidate = null;
    this.leaderlessSince = 0;
    this.electionAttempt = 0;
    const resume = isInt(p.resume, 0, 60_000) ? p.resume : 0;
    this.resumeAt = this.clock.now() + resume;
    this.stats.syncsAdopted++;
    if (this.mode === "joining") this.sendJoin(from);
    this.rebuildPlaceSeq();
    this.rebuildMatchEnd();
    this.prunePending();
    this.reconcileLocal(true);
    if (wasHost || prevHost !== from) this.events.emit("event", { kind: "host-changed", hostId: from, epoch: e });
    if (this.log.state.phase !== "playing" && this.log.state.phase !== "countdown") this.abandoned = false;
    this.ackDue = true;
    this.changed();
  }

  // ============================================================ elections

  private priorityOrder(): string[] {
    const st = this.log?.state;
    if (!st) return [];
    return [...st.roster].sort((a, b) => a.seat - b.seat || (a.playerId < b.playerId ? -1 : 1)).map((r) => r.playerId);
  }

  /** Eligible candidates in deterministic priority order: connected voting members, minus the lost host. */
  private electionOrder(): string[] {
    const members = new Set(this.members());
    return this.priorityOrder().filter((p) => members.has(p) && p !== this.formerHost && this.isUp(p));
  }

  private enterLeaderless(reason: string): void {
    if (this.mode === "leaderless" || this.mode === "candidate") return;
    const former = this.hostId;
    this.mode = "leaderless";
    this.formerHost = former;
    this.hostId = null;
    this.leaderlessSince = this.clock.now();
    this.electionAttempt = 0;
    this.candidate = null;
    this.computeNextCandidacy();
    this.events.emit("event", { kind: "migration-start", formerHost: former, reason });
    this.changed();
  }

  private computeNextCandidacy(): void {
    const order = this.electionOrder();
    const rank = order.indexOf(this.playerId);
    const now = this.clock.now();
    if (rank < 0) {
      this.nextCandidacyAt = Infinity;
      return;
    }
    const backoff = this.electionAttempt === 0 ? 0 : this.cfg.electionStaggerMs * (1 + (this.electionAttempt % 3));
    this.nextCandidacyAt = now + rank * this.cfg.electionStaggerMs + backoff;
  }

  private higherCandidateActive(than: string): boolean {
    const order = this.priorityOrder();
    const myRank = order.indexOf(than);
    const now = this.clock.now();
    for (const [pid, t] of this.recentCandidates) {
      if (now - t > this.cfg.electionTimeoutMs || !this.isUp(pid)) continue;
      const r = order.indexOf(pid);
      if (r >= 0 && r < myRank) return true;
    }
    return false;
  }

  private considersHostDead(): boolean {
    if (this.mode === "host") return false;
    if (this.mode === "leaderless" || this.mode === "candidate" || this.hostId === null) return true;
    return this.clock.now() - this.hostLastHeard > this.cfg.hostTimeoutMs;
  }

  private startPrevote(): void {
    if (!this.log) return;
    this.stats.elections++;
    this.mode = "candidate";
    this.candidate = { epoch: this.epoch + 1, phase: "pre", grants: new Set([this.playerId]), votes: new Map(), deadline: this.clock.now() + this.cfg.electionTimeoutMs };
    this.recentCandidates.set(this.playerId, this.clock.now());
    this.send("prevote", { e: this.candidate.epoch, ls: this.log.lastSeq, le: this.log.lastEpoch }, this.members().filter((p) => p !== this.playerId));
    this.checkCandidate();
    this.changed();
  }

  private onPrevote(from: string, p: Record<string, unknown>): void {
    if (!isInt(p.e, 1, Number.MAX_SAFE_INTEGER) || !this.log) return;
    const members = this.members();
    const ok = p.e > this.epoch && this.considersHostDead() && members.includes(from) && !this.higherCandidateActive(from);
    this.recentCandidates.set(from, this.clock.now());
    this.send("prevote_r", { e: p.e, ok, ve: this.epoch }, from);
  }

  private onPrevoteReply(from: string, p: Record<string, unknown>): void {
    const c = this.candidate;
    if (!c || c.phase !== "pre" || p.e !== c.epoch) return;
    if (p.ok === true) {
      c.grants.add(from);
      this.checkCandidate();
    } else if (isInt(p.ve, 0, Number.MAX_SAFE_INTEGER) && p.ve >= c.epoch) {
      this.epoch = Math.max(this.epoch, p.ve);
      this.abandonCandidacy();
    }
  }

  private checkCandidate(): void {
    const c = this.candidate;
    if (!c || !this.log) return;
    const q = this.quorum();
    if (c.phase === "pre" && c.grants.size >= q) {
      this.epoch = c.epoch;
      this.votedFor.set(c.epoch, this.playerId);
      c.phase = "vote";
      c.deadline = this.clock.now() + this.cfg.electionTimeoutMs;
      c.votes.set(this.playerId, null);
      this.send("vote_req", { e: c.epoch }, this.members().filter((p) => p !== this.playerId));
    }
    if (c.phase === "vote" && c.votes.size >= q) this.becomeHost();
  }

  private onVoteReq(from: string, p: Record<string, unknown>): void {
    if (!isInt(p.e, 1, Number.MAX_SAFE_INTEGER) || !this.log) return;
    const e = p.e;
    const prior = this.votedFor.get(e);
    const grant = e >= this.epoch && (prior === undefined || prior === from) && this.considersHostDead() && this.members().includes(from);
    if (grant) {
      this.epoch = e;
      this.votedFor.set(e, from);
      this.recentCandidates.set(from, this.clock.now());
      if (this.mode === "candidate" && from !== this.playerId) {
        this.candidate = null;
        this.mode = "leaderless";
      }
    }
    this.send("vote", { e, ok: grant, ve: this.epoch, ...(grant ? { x: this.log.export() } : {}) }, from);
  }

  private onVote(from: string, p: Record<string, unknown>): void {
    const c = this.candidate;
    if (!c || c.phase !== "vote" || p.e !== c.epoch) return;
    if (p.ok === true && p.x !== undefined) {
      c.votes.set(from, p.x);
      this.checkCandidate();
    } else if (isInt(p.ve, 0, Number.MAX_SAFE_INTEGER) && p.ve > c.epoch) {
      this.epoch = p.ve;
      this.abandonCandidacy();
    }
  }

  private abandonCandidacy(): void {
    this.candidate = null;
    this.mode = "leaderless";
    this.electionAttempt++;
    this.computeNextCandidacy();
    this.changed();
  }

  private becomeHost(): void {
    const c = this.candidate;
    if (!c || !this.log) return;
    // Recover from the most up-to-date state anyone in the quorum holds.
    const ranked = [...c.votes.entries()]
      .filter(([pid]) => pid !== this.playerId)
      .map(([pid, x]) => ({ pid, x, last: lastOf(x) }))
      .filter((v) => v.last !== null)
      .sort((a, b) => ReplicatedLog.compare(b.last!, a.last!));
    let recoveredFrom = this.playerId;
    for (const v of ranked) {
      if (ReplicatedLog.compare(v.last!, { lastEpoch: this.log.lastEpoch, lastSeq: this.log.lastSeq }) <= 0) break;
      try {
        this.log = ReplicatedLog.fromExport(v.x, this.rules);
        recoveredFrom = v.pid;
        break;
      } catch {
        this.stats.invalid++;
      }
    }
    const now = this.clock.now();
    const pausedFor = this.leaderlessSince ? now - this.leaderlessSince : 0;
    const former = this.formerHost;
    this.mode = "host";
    this.hostId = this.playerId;
    this.candidate = null;
    this.formerHost = null;
    this.electionAttempt = 0;
    this.acks = new Map();
    this.epochStartSeq = this.log.lastSeq + 1;
    this.resumeAt = now + this.cfg.resumeDelayMs;
    this.disconnectedSince = new Map();
    this.leaderlessSince = 0;
    this.abandoned = false;

    const st = this.log.state;
    const bodies: EntryBody[] = [{ k: "noop" }];
    for (const r of st.roster) {
      if (this.departed.has(r.playerId)) continue; // removed by hostTick once membership changes may proceed
      const up = this.isUp(r.playerId) && r.playerId !== former;
      if (r.connected !== up) bodies.push({ k: "presence", playerId: r.playerId, connected: up });
      if (!up) this.disconnectedSince.set(r.playerId, now);
    }
    const inMatch = st.phase === "playing" || st.phase === "countdown";
    if (inMatch && pausedFor > this.cfg.migrationGiveUpMs) bodies.push({ k: "end", reason: "no-contest" });

    // Broadcast full state first so followers can apply the new epoch's entries.
    this.sendSync();
    this.hostAppend(bodies);
    const ph = this.log.state.phase;
    this.clockBase = this.log.state.match?.elapsedMs ?? 0;
    this.clockStart = this.resumeAt;
    this.goAt = ph === "countdown" ? this.resumeAt + this.cfg.countdownMs : null;
    this.rebuildPlaceSeq();
    this.rebuildMatchEnd();
    this.reconcileLocal(true);
    this.events.emit("event", { kind: "host-changed", hostId: this.playerId, epoch: this.epoch, recoveredFrom });
    this.changed();
  }

  // ============================================================ local player

  private trackPlace(e: LogEntry): void {
    if (e.k === "place" && e.playerId === this.playerId) this.placeSeq.set(e.pl.pieceIndex, e.seq);
  }

  private rebuildPlaceSeq(): void {
    this.placeSeq.clear();
    if (!this.log) return;
    for (const e of this.log.entriesAfter(0)) this.trackPlace(e);
  }

  /** Drop pending placements once their entries are committed. */
  private prunePending(): void {
    const l = this.local;
    const mp = this.log?.state.match?.players[this.playerId];
    if (!l || !mp) return;
    const roomPieces = mp.sim.s.piecesPlaced;
    l.pending = l.pending.filter((p) => {
      if (p.pieceIndex >= roomPieces) return true;
      const seq = this.placeSeq.get(p.pieceIndex);
      return seq !== undefined && seq > this.commit;
    });
    for (const id of [...l.consumed]) if (!mp.commanded.some((c) => c.id === id)) l.consumed.delete(id);
  }

  private reconcileLocal(afterSync: boolean): void {
    const st = this.log?.state;
    const m = st?.match;
    const mp = m?.players[this.playerId];
    if (!m || !mp) {
      this.local = null;
      return;
    }
    if (!this.local || this.local.matchId !== m.matchId) {
      this.local = { matchId: m.matchId, sim: mp.sim.clone(), pending: [], consumed: new Set(), hashAt: new Map() };
      return;
    }
    const l = this.local;
    const room = mp.sim;
    const roomPieces = room.s.piecesPlaced;
    if (l.sim.s.piecesPlaced < roomPieces) return this.resyncLocal("behind");
    const expected = l.hashAt.get(roomPieces);
    if (l.sim.s.piecesPlaced === roomPieces) {
      if (l.sim.hash() !== room.hash()) return this.resyncLocal("diverged");
    } else if (expected !== undefined && expected !== room.hash()) return this.resyncLocal("diverged");
    if (!mp.alive && !l.sim.s.toppedOut) return this.resyncLocal("eliminated");
    // Placements the authoritative log does not have yet must be (re)sent.
    const ahead = l.pending.filter((p) => p.pieceIndex >= roomPieces).sort((a, b) => a.pieceIndex - b.pieceIndex);
    if (ahead.length !== l.sim.s.piecesPlaced - roomPieces || ahead.some((p, i) => p.pieceIndex !== roomPieces + i)) return this.resyncLocal("missing-pending");
    if (afterSync) for (const p of ahead) this.sendPlace(p);
    for (const k of [...l.hashAt.keys()]) if (k < roomPieces) l.hashAt.delete(k);
  }

  private resyncLocal(reason: string): void {
    const mp = this.log?.state.match?.players[this.playerId];
    if (!mp || !this.log?.state.match) {
      this.local = null;
      return;
    }
    this.local = { matchId: this.log.state.match.matchId, sim: mp.sim.clone(), pending: [], consumed: new Set(), hashAt: new Map() };
    this.events.emit("event", { kind: "resync", reason });
  }

  private sendPlace(pl: Placement): void {
    const mid = this.local?.matchId;
    if (!mid) return;
    if (this.mode === "host") this.hostHandlePlace(this.playerId, mid, pl);
    else if (this.hostId) this.send("place", { mid, pl }, this.hostId);
  }

  private isMatchEndCommitted(): boolean {
    return !!this.log && this.log.state.phase === "ended" && this.commit >= this.matchEndSeq;
  }

  /** After adopting a whole log, find the entry that ended the match (conservative if ambiguous). */
  private rebuildMatchEnd(): void {
    this.lastMembershipSeq = 0;
    for (const e of this.log?.entriesAfter(0) ?? []) if (e.k === "join" || e.k === "leave") this.lastMembershipSeq = e.seq;
    this.matchEndSeq = Infinity;
    if (!this.log || this.log.state.phase !== "ended") return;
    const entries = this.log.entriesAfter(0);
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.k === "place" || e.k === "leave" || e.k === "end") {
        this.matchEndSeq = e.seq;
        return;
      }
    }
    this.matchEndSeq = this.log.checkpointSeq;
  }

  private handleEffects(effects: Effect[], seq: number): void {
    for (const effect of effects) {
      if (effect.kind === "match-end") this.matchEndSeq = seq;
      if (effect.kind === "joined" || effect.kind === "left") this.lastMembershipSeq = Math.max(this.lastMembershipSeq, seq);
      if (effect.kind === "joined") this.departed.delete(effect.playerId);
      if (effect.kind === "lobby") this.matchEndSeq = Infinity;
      if (effect.kind === "match-start") {
        this.local = null;
        this.placeSeq.clear();
        this.remotePieces.clear();
        this.remoteLocks.clear();
        this.lastLiveIdx = -1;
        this.livePiece = null;
        this.abandoned = false;
      }
      this.events.emit("event", { kind: "effect", effect, committed: false });
    }
  }

  // ============================================================ timers

  private tick(): void {
    if (this.mode === "left") return;
    const now = this.clock.now();
    switch (this.mode) {
      case "host":
        this.hostTick(now);
        break;
      case "follower":
        if (now - this.hostLastHeard > this.cfg.hostTimeoutMs) this.enterLeaderless("host-timeout");
        break;
      case "leaderless":
        if (now >= this.nextCandidacyAt && !this.higherCandidateActive(this.playerId)) this.startPrevote();
        break;
      case "candidate":
        if (this.candidate && now > this.candidate.deadline) this.abandonCandidacy();
        break;
      case "joining": {
        const alone = this.hostIfAloneAfterMs;
        // Recreate only if nobody has shown an active room for the whole wait.
        if (alone !== null && now - this.joinStartedAt > alone && now - this.roomSeenAt > alone) {
          this.hostIfAloneAfterMs = null;
          this.bootstrapAsHost();
          this.events.emit("event", { kind: "host-changed", hostId: this.playerId, epoch: this.epoch });
          this.changed();
        } else this.sendJoin();
        break;
      }
    }
    if ((this.mode === "leaderless" || this.mode === "candidate") && !this.abandoned) {
      const ph = this.log?.state.phase;
      if ((ph === "playing" || ph === "countdown") && now - this.leaderlessSince > this.cfg.migrationGiveUpMs) {
        this.abandoned = true;
        this.events.emit("event", { kind: "match-abandoned" });
        this.changed();
      }
    }
    if (this.ackDue && this.mode === "follower" && this.hostId && this.log) {
      this.ackDue = false;
      this.send("ack", { e: this.epoch, s: this.log.lastSeq }, this.hostId, "state");
    }
    this.flushLive();
  }

  private hostTick(now: number): void {
    const st = this.log?.state;
    if (!st) return;
    const inMatch = st.phase === "playing" || st.phase === "countdown";
    if (inMatch) {
      const heard = this.members().filter((p) => p === this.playerId || (this.mesh.isConnected(p) && now - (this.mesh.lastHeard(p) ?? -Infinity) < this.cfg.leaseMs));
      if (heard.length < this.quorum()) return this.stepDown("lost-quorum");
    }
    for (const r of [...st.roster]) {
      if (r.playerId === this.playerId) continue;
      if (this.departed.has(r.playerId)) {
        if (this.membershipChangeAllowed()) this.hostAppend([{ k: "leave", playerId: r.playerId, reason: "left" }]);
        continue;
      }
      if (r.connected) continue;
      const since = this.disconnectedSince.get(r.playerId) ?? now;
      this.disconnectedSince.set(r.playerId, since);
      if (now - since > this.cfg.reconnectGraceMs && this.membershipChangeAllowed()) {
        this.disconnectedSince.delete(r.playerId);
        this.hostAppend([{ k: "leave", playerId: r.playerId, reason: "timeout" }]);
      }
    }
    if (st.phase === "countdown" && this.goAt !== null && now >= this.goAt) {
      this.goAt = null;
      this.clockBase = 0;
      this.clockStart = now;
      this.hostAppend([{ k: "go" }]);
    }
  }

  private changed(): void {
    this.events.emit("change");
  }
}

function lastOf(x: unknown): { lastEpoch: number; lastSeq: number } | null {
  if (!isObj(x) || !isObj(x.checkpoint) || !Array.isArray(x.entries)) return null;
  const last = x.entries.at(-1) as LogEntry | undefined;
  if (last && isInt(last.seq, 1, Number.MAX_SAFE_INTEGER) && isInt(last.epoch, 1, Number.MAX_SAFE_INTEGER)) return { lastEpoch: last.epoch, lastSeq: last.seq };
  const cp = x.checkpoint;
  if (isInt(cp.seq, 0, Number.MAX_SAFE_INTEGER) && isInt(cp.epoch, 0, Number.MAX_SAFE_INTEGER)) return { lastEpoch: cp.epoch, lastSeq: cp.seq };
  return null;
}

export type { LogExport };

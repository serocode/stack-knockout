import {
  PlayerSim,
  cancelGarbage,
  deriveSeed,
  hashString,
  rngInt,
  type GarbageChunk,
  type LockResult,
  type Placement,
  type SerializedPlayerSim,
} from "@tk/engine";
import { cleanName, isBool, isCosmetics, isInt, isObj, isPid, isPlacement, isStr, type Cosmetics } from "./validate.js";

export const MAX_PLAYERS = 6;
export const MIN_PLAYERS = 2;

export interface Rules {
  /** Match-time ms an attack waits before it can be inserted (cancellation window). */
  garbageDelayMs: number;
  /** Max garbage rows inserted on a single lock. */
  garbageCapPerLock: number;
  /** Pieces a player may lock before inserting a commanded chunk (absorbs network latency). */
  garbageLagPieces: number;
}

export const DEFAULT_RULES: Rules = { garbageDelayMs: 500, garbageCapPerLock: 8, garbageLagPieces: 6 };

export type Phase = "lobby" | "countdown" | "playing" | "ended";
export type Role = "player" | "spectator";
export type TargetMode = "random" | "manual" | "revenge";

export interface RosterEntry {
  playerId: string;
  name: string;
  seat: number;
  role: Role;
  ready: boolean;
  connected: boolean;
  cosmetics: Cosmetics;
}

export interface IncomingGarbage {
  id: string;
  from: string;
  lines: number;
  holeCol: number;
  queuedAt: number;
}

export interface CommandedGarbage extends GarbageChunk {
  from: string;
  issuedAtPiece: number;
}

export interface MatchPlayer {
  sim: PlayerSim;
  alive: boolean;
  placement: number | null;
  eliminatedBy: string | null;
  incoming: IncomingGarbage[];
  commanded: CommandedGarbage[];
  targetMode: TargetMode;
  manualTarget: string | null;
  lastAttacker: string | null;
  lastTarget: string | null;
  attackSent: number;
  attackReceived: number;
  kos: number;
}

export interface Ranking {
  playerId: string;
  placement: number;
  kos: number;
  attackSent: number;
  score: number;
  lines: number;
}

export interface MatchResult {
  matchId: string;
  reason: "knockout" | "no-contest";
  winner: string | null;
  rankings: Ranking[];
}

export interface MatchState {
  matchId: string;
  seed: number;
  participants: string[];
  players: Record<string, MatchPlayer>;
  rng: number;
  garbageCounter: number;
  elapsedMs: number;
  result: MatchResult | null;
}

export interface RoomState {
  roster: RosterEntry[];
  nextSeat: number;
  phase: Phase;
  match: MatchState | null;
  lastResult: MatchResult | null;
  closed: boolean;
  matchCounter: number;
}

export type EntryBody =
  | { k: "noop" }
  | { k: "join"; playerId: string; name: string; cosmetics: Cosmetics }
  | { k: "presence"; playerId: string; connected: boolean }
  | { k: "leave"; playerId: string; reason: "left" | "timeout" }
  | { k: "ready"; playerId: string; ready: boolean }
  | { k: "cosmetics"; playerId: string; cosmetics: Cosmetics }
  | { k: "start"; matchId: string; seed: number }
  | { k: "go" }
  | { k: "place"; playerId: string; t: number; pl: Placement }
  | { k: "target"; playerId: string; mode: TargetMode; target: string | null }
  | { k: "end"; reason: "no-contest" }
  | { k: "rematch" }
  | { k: "close" };

export type LogEntry = EntryBody & { seq: number; epoch: number };

export type Effect =
  | { kind: "joined"; playerId: string }
  | { kind: "left"; playerId: string; reason: "left" | "timeout" }
  | { kind: "presence"; playerId: string; connected: boolean }
  | { kind: "match-start"; matchId: string }
  | { kind: "go" }
  | { kind: "lock"; playerId: string; pieceIndex: number; result: LockResult }
  | { kind: "attack"; from: string; to: string; lines: number }
  | { kind: "cancel"; playerId: string; lines: number }
  | { kind: "ko"; victim: string; by: string | null; placement: number }
  | { kind: "match-end"; result: MatchResult }
  | { kind: "lobby" }
  | { kind: "closed" };

export type ApplyResult = { ok: true; effects: Effect[] } | { ok: false; error: string };

export function createRoomState(): RoomState {
  return { roster: [], nextSeat: 0, phase: "lobby", match: null, lastResult: null, closed: false, matchCounter: 0 };
}

export const rosterIds = (s: RoomState): string[] => s.roster.map((r) => r.playerId);
export const findRoster = (s: RoomState, pid: string): RosterEntry | undefined => s.roster.find((r) => r.playerId === pid);

function aliveOpponents(m: MatchState, pid: string): string[] {
  return m.participants.filter((p) => p !== pid && m.players[p]?.alive);
}

function pickTarget(m: MatchState, pid: string): string | null {
  const opp = aliveOpponents(m, pid);
  if (opp.length === 0) return null;
  const mp = m.players[pid]!;
  if (mp.targetMode === "manual" && mp.manualTarget && opp.includes(mp.manualTarget)) return mp.manualTarget;
  if (mp.targetMode === "revenge" && mp.lastAttacker && opp.includes(mp.lastAttacker)) return mp.lastAttacker;
  const [i, next] = rngInt(m.rng, opp.length);
  m.rng = next;
  return opp[i]!;
}

function rankings(m: MatchState): Ranking[] {
  return m.participants
    .map((pid) => {
      const p = m.players[pid]!;
      return { playerId: pid, placement: p.placement ?? 1, kos: p.kos, attackSent: p.attackSent, score: p.sim.s.score, lines: p.sim.s.lines };
    })
    .sort((a, b) => a.placement - b.placement);
}

function eliminate(s: RoomState, m: MatchState, pid: string, by: string | null, effects: Effect[]): void {
  const mp = m.players[pid];
  if (!mp || !mp.alive) return;
  const aliveBefore = m.participants.filter((p) => m.players[p]!.alive).length;
  mp.alive = false;
  if (!mp.sim.s.toppedOut) mp.sim.forfeit();
  mp.placement = aliveBefore;
  mp.incoming = [];
  mp.commanded = [];
  const killer = by && by !== pid && m.players[by] ? by : null;
  mp.eliminatedBy = killer;
  if (killer) m.players[killer]!.kos++;
  effects.push({ kind: "ko", victim: pid, by: killer, placement: aliveBefore });
  const alive = m.participants.filter((p) => m.players[p]!.alive);
  if (alive.length <= 1) {
    const winner = alive[0] ?? null;
    if (winner) m.players[winner]!.placement = 1;
    m.result = { matchId: m.matchId, reason: "knockout", winner, rankings: rankings(m) };
    s.phase = "ended";
    s.lastResult = m.result;
    effects.push({ kind: "match-end", result: m.result });
  }
}

function applyPlace(s: RoomState, e: Extract<EntryBody, { k: "place" }>, rules: Rules): ApplyResult {
  const m = s.match;
  if (s.phase !== "playing" || !m) return { ok: false, error: "not-playing" };
  const mp = m.players[e.playerId];
  if (!mp) return { ok: false, error: "not-participant" };
  if (!mp.alive) return { ok: false, error: "eliminated" };
  const ids = e.pl.garbageIds;
  if (ids.length > mp.commanded.length) return { ok: false, error: "bad-garbage" };
  for (let i = 0; i < ids.length; i++) if (mp.commanded[i]!.id !== ids[i]) return { ok: false, error: "bad-garbage" };
  for (let i = ids.length; i < mp.commanded.length; i++) {
    if (mp.commanded[i]!.issuedAtPiece <= e.pl.pieceIndex - rules.garbageLagPieces) return { ok: false, error: "withheld-garbage" };
  }
  const chunks = mp.commanded.slice(0, ids.length);
  const out = mp.sim.applyPlacement(e.pl, chunks);
  if (!out.ok) return { ok: false, error: out.error };

  // --- committed from here on ---
  const effects: Effect[] = [];
  const r = out.result;
  mp.commanded.splice(0, ids.length);
  for (const c of chunks) {
    mp.lastAttacker = c.from;
    mp.attackReceived += c.lines;
  }
  m.elapsedMs = Math.max(m.elapsedMs, e.t);
  effects.push({ kind: "lock", playerId: e.playerId, pieceIndex: e.pl.pieceIndex, result: r });

  if (r.attack > 0) {
    const c = cancelGarbage(mp.incoming, r.attack);
    const byId = new Map(mp.incoming.map((g) => [g.id, g]));
    mp.incoming = c.queue.map((q) => ({ ...byId.get(q.id)!, lines: q.lines }));
    const cancelled = r.attack - c.remaining;
    if (cancelled > 0) effects.push({ kind: "cancel", playerId: e.playerId, lines: cancelled });
    if (c.remaining > 0) {
      const target = pickTarget(m, e.playerId);
      if (target) {
        const [hole, next] = rngInt(m.rng, 10);
        m.rng = next;
        m.players[target]!.incoming.push({ id: `g${m.garbageCounter++}`, from: e.playerId, lines: c.remaining, holeCol: hole, queuedAt: m.elapsedMs });
        mp.attackSent += c.remaining;
        mp.lastTarget = target;
        effects.push({ kind: "attack", from: e.playerId, to: target, lines: c.remaining });
      }
    }
  }

  if (r.toppedOut) {
    eliminate(s, m, e.playerId, mp.lastAttacker, effects);
    return { ok: true, effects };
  }

  if (r.lines === 0) {
    let cap = rules.garbageCapPerLock;
    while (cap > 0 && mp.incoming.length > 0 && mp.incoming[0]!.queuedAt <= m.elapsedMs - rules.garbageDelayMs) {
      const g = mp.incoming[0]!;
      const take = Math.min(g.lines, cap);
      cap -= take;
      mp.commanded.push({ id: `c${m.garbageCounter++}`, lines: take, holeCol: g.holeCol, from: g.from, issuedAtPiece: mp.sim.s.piecesPlaced });
      if (take === g.lines) mp.incoming.shift();
      else g.lines -= take;
    }
  }
  return { ok: true, effects };
}

/**
 * The replicated state machine. Every peer applies the same entries in the
 * same order and reaches the same state. On failure the state is untouched.
 */
export function applyEntry(s: RoomState, e: EntryBody, rules: Rules = DEFAULT_RULES): ApplyResult {
  const ok = (...effects: Effect[]): ApplyResult => ({ ok: true, effects });
  switch (e.k) {
    case "noop":
      return ok();
    case "join": {
      const existing = findRoster(s, e.playerId);
      if (existing) {
        existing.name = e.name;
        existing.cosmetics = e.cosmetics;
        existing.connected = true;
        return ok({ kind: "presence", playerId: e.playerId, connected: true });
      }
      if (s.closed) return { ok: false, error: "closed" };
      if (s.roster.length >= MAX_PLAYERS) return { ok: false, error: "full" };
      s.roster.push({
        playerId: e.playerId,
        name: e.name,
        seat: s.nextSeat++,
        role: s.phase === "lobby" ? "player" : "spectator",
        ready: false,
        connected: true,
        cosmetics: e.cosmetics,
      });
      return ok({ kind: "joined", playerId: e.playerId });
    }
    case "presence": {
      const r = findRoster(s, e.playerId);
      if (!r) return { ok: false, error: "unknown-player" };
      r.connected = e.connected;
      return ok({ kind: "presence", playerId: e.playerId, connected: e.connected });
    }
    case "leave": {
      const idx = s.roster.findIndex((r) => r.playerId === e.playerId);
      if (idx < 0) return { ok: false, error: "unknown-player" };
      s.roster.splice(idx, 1);
      const effects: Effect[] = [{ kind: "left", playerId: e.playerId, reason: e.reason }];
      if (s.match && (s.phase === "playing" || s.phase === "countdown") && s.match.players[e.playerId]?.alive) {
        eliminate(s, s.match, e.playerId, null, effects);
      }
      return { ok: true, effects };
    }
    case "ready": {
      const r = findRoster(s, e.playerId);
      if (!r || s.phase !== "lobby") return { ok: false, error: "bad-ready" };
      r.ready = e.ready;
      return ok();
    }
    case "cosmetics": {
      const r = findRoster(s, e.playerId);
      if (!r) return { ok: false, error: "unknown-player" };
      r.cosmetics = e.cosmetics;
      return ok();
    }
    case "start": {
      if (s.phase !== "lobby") return { ok: false, error: "bad-phase" };
      const participants = s.roster.filter((r) => r.role === "player").map((r) => r.playerId);
      if (participants.length < MIN_PLAYERS) return { ok: false, error: "not-enough-players" };
      const players: Record<string, MatchPlayer> = {};
      for (const pid of participants) {
        players[pid] = {
          sim: PlayerSim.create(deriveSeed(e.seed, pid)),
          alive: true,
          placement: null,
          eliminatedBy: null,
          incoming: [],
          commanded: [],
          targetMode: "random",
          manualTarget: null,
          lastAttacker: null,
          lastTarget: null,
          attackSent: 0,
          attackReceived: 0,
          kos: 0,
        };
      }
      s.match = { matchId: e.matchId, seed: e.seed >>> 0, participants, players, rng: deriveSeed(e.seed, "match"), garbageCounter: 0, elapsedMs: 0, result: null };
      s.matchCounter++;
      s.phase = "countdown";
      for (const r of s.roster) r.ready = false;
      return ok({ kind: "match-start", matchId: e.matchId });
    }
    case "go":
      if (s.phase !== "countdown") return { ok: false, error: "bad-phase" };
      s.phase = "playing";
      return ok({ kind: "go" });
    case "place":
      return applyPlace(s, e, rules);
    case "target": {
      const mp = s.match?.players[e.playerId];
      if (!mp) return { ok: false, error: "not-participant" };
      mp.targetMode = e.mode;
      mp.manualTarget = e.mode === "manual" ? e.target : null;
      return ok();
    }
    case "end": {
      if (!s.match || (s.phase !== "playing" && s.phase !== "countdown")) return { ok: false, error: "bad-phase" };
      const m = s.match;
      m.result = { matchId: m.matchId, reason: "no-contest", winner: null, rankings: rankings(m) };
      s.phase = "ended";
      s.lastResult = m.result;
      return ok({ kind: "match-end", result: m.result });
    }
    case "rematch": {
      if (s.phase !== "ended") return { ok: false, error: "bad-phase" };
      s.phase = "lobby";
      s.match = null;
      for (const r of s.roster) {
        r.ready = false;
        r.role = "player";
      }
      return ok({ kind: "lobby" });
    }
    case "close":
      s.closed = true;
      return ok({ kind: "closed" });
  }
}

// ------------------------------------------------------------- serialization

interface SerializedMatchPlayer extends Omit<MatchPlayer, "sim"> {
  sim: SerializedPlayerSim;
}
interface SerializedMatch extends Omit<MatchState, "players"> {
  players: Record<string, SerializedMatchPlayer>;
}
export interface SerializedRoomState extends Omit<RoomState, "match"> {
  match: SerializedMatch | null;
}

export function serializeState(s: RoomState): SerializedRoomState {
  const match: SerializedMatch | null = s.match
    ? {
        ...s.match,
        participants: [...s.match.participants],
        players: Object.fromEntries(
          Object.entries(s.match.players).map(([pid, p]) => [
            pid,
            {
              ...p,
              sim: p.sim.serialize(),
              incoming: p.incoming.map((g) => ({ ...g })),
              commanded: p.commanded.map((g) => ({ ...g })),
            },
          ]),
        ),
        result: s.match.result ? structuredClone(s.match.result) : null,
      }
    : null;
  return {
    roster: s.roster.map((r) => ({ ...r, cosmetics: { ...r.cosmetics } })),
    nextSeat: s.nextSeat,
    phase: s.phase,
    match,
    lastResult: s.lastResult ? structuredClone(s.lastResult) : null,
    closed: s.closed,
    matchCounter: s.matchCounter,
  };
}

/** Throws on malformed input. Received states come from peers and are untrusted. */
export function deserializeState(d: unknown): RoomState {
  if (!isObj(d)) throw new Error("state");
  const roster = d.roster;
  if (!Array.isArray(roster) || roster.length > MAX_PLAYERS) throw new Error("roster");
  const outRoster: RosterEntry[] = roster.map((r) => {
    if (!isObj(r) || !isPid(r.playerId) || !isInt(r.seat, 0, 1e6) || !isBool(r.ready) || !isBool(r.connected) || !isCosmetics(r.cosmetics))
      throw new Error("roster entry");
    const name = cleanName(r.name);
    if (!name || (r.role !== "player" && r.role !== "spectator")) throw new Error("roster entry");
    return { playerId: r.playerId, name, seat: r.seat, role: r.role, ready: r.ready, connected: r.connected, cosmetics: { ...r.cosmetics } };
  });
  const phase = d.phase;
  if (phase !== "lobby" && phase !== "countdown" && phase !== "playing" && phase !== "ended") throw new Error("phase");
  if (!isInt(d.nextSeat, 0, 1e6) || !isBool(d.closed) || !isInt(d.matchCounter, 0, 1e6)) throw new Error("fields");
  let match: MatchState | null = null;
  if (d.match !== null) {
    const m = d.match;
    if (!isObj(m) || !isStr(m.matchId, 48) || !isInt(m.seed, 0, 0xffffffff) || !isInt(m.rng, 0, 0xffffffff)) throw new Error("match");
    if (!Array.isArray(m.participants) || !m.participants.every(isPid) || m.participants.length > MAX_PLAYERS) throw new Error("participants");
    if (!isObj(m.players) || !isInt(m.garbageCounter, 0, 1e9) || typeof m.elapsedMs !== "number") throw new Error("match fields");
    const players: Record<string, MatchPlayer> = {};
    for (const pid of m.participants as string[]) {
      const p = m.players[pid];
      if (!isObj(p) || !isBool(p.alive) || !Array.isArray(p.incoming) || !Array.isArray(p.commanded)) throw new Error("player");
      const tm = p.targetMode;
      if (tm !== "random" && tm !== "manual" && tm !== "revenge") throw new Error("target mode");
      players[pid] = {
        sim: PlayerSim.deserialize(p.sim as SerializedPlayerSim),
        alive: p.alive,
        placement: p.placement === null ? null : (p.placement as number),
        eliminatedBy: (p.eliminatedBy as string | null) ?? null,
        incoming: (p.incoming as IncomingGarbage[]).map((g) => ({ ...g })),
        commanded: (p.commanded as CommandedGarbage[]).map((g) => ({ ...g })),
        targetMode: tm,
        manualTarget: (p.manualTarget as string | null) ?? null,
        lastAttacker: (p.lastAttacker as string | null) ?? null,
        lastTarget: (p.lastTarget as string | null) ?? null,
        attackSent: Number(p.attackSent) | 0,
        attackReceived: Number(p.attackReceived) | 0,
        kos: Number(p.kos) | 0,
      };
    }
    match = {
      matchId: m.matchId,
      seed: m.seed,
      participants: [...(m.participants as string[])],
      players,
      rng: m.rng,
      garbageCounter: m.garbageCounter,
      elapsedMs: m.elapsedMs,
      result: (m.result as MatchResult | null) ?? null,
    };
  }
  return {
    roster: outRoster,
    nextSeat: d.nextSeat,
    phase,
    match,
    lastResult: (d.lastResult as MatchResult | null) ?? null,
    closed: d.closed,
    matchCounter: d.matchCounter,
  };
}

export function stateHash(s: RoomState): number {
  return hashString(JSON.stringify(serializeState(s)));
}

// ----------------------------------------------------------- entry validation

const ENTRY_KINDS = new Set(["noop", "join", "presence", "leave", "ready", "cosmetics", "start", "go", "place", "target", "end", "rematch", "close"]);

export function isLogEntry(v: unknown): v is LogEntry {
  if (!isObj(v) || !isInt(v.seq, 1, Number.MAX_SAFE_INTEGER) || !isInt(v.epoch, 1, Number.MAX_SAFE_INTEGER)) return false;
  if (typeof v.k !== "string" || !ENTRY_KINDS.has(v.k)) return false;
  switch (v.k) {
    case "join":
      return isPid(v.playerId) && cleanName(v.name) === v.name && isCosmetics(v.cosmetics);
    case "presence":
      return isPid(v.playerId) && isBool(v.connected);
    case "leave":
      return isPid(v.playerId) && (v.reason === "left" || v.reason === "timeout");
    case "ready":
      return isPid(v.playerId) && isBool(v.ready);
    case "cosmetics":
      return isPid(v.playerId) && isCosmetics(v.cosmetics);
    case "start":
      return isStr(v.matchId, 48) && isInt(v.seed, 0, 0xffffffff);
    case "place":
      return isPid(v.playerId) && typeof v.t === "number" && Number.isFinite(v.t) && v.t >= 0 && isPlacement(v.pl);
    case "target":
      return isPid(v.playerId) && (v.mode === "random" || v.mode === "manual" || v.mode === "revenge") && (v.target === null || isPid(v.target));
    case "end":
      return v.reason === "no-contest";
    default:
      return true;
  }
}

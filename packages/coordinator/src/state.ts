import {
  BOMB_BLASTS,
  MAX_BOMB_BONUS,
  PlayerSim,
  cancelGarbage,
  deriveSeed,
  hashString,
  rngInt,
  type GarbageChunk,
  type LockResult,
  type Placement,
  type BombBlast,
  type SerializedPlayerSim,
} from "@tk/engine";
import { cleanName, isBool, isCosmetics, isInt, isObj, isPid, isPlacement, isStr, type Cosmetics } from "./validate.js";

export const MAX_PLAYERS = 10;
export const MIN_PLAYERS = 2;
/** Team matches are at most 5 v 5. */
export const MAX_TEAM_SIZE = 5;
export const MAX_ROUNDS = 10;
/** Team ids. Every roster entry has one; it only matters when the room plays teams. */
export const TEAM_IDS = [1, 2] as const;
export type TeamId = (typeof TEAM_IDS)[number];
export const isTeamId = (v: unknown): v is TeamId => v === 1 || v === 2;
const MAX_KICKED = 64;

export interface Rules {
  /** Match-time ms an attack waits before it can be inserted (cancellation window). */
  garbageDelayMs: number;
  /** Max garbage rows inserted on a single lock. */
  garbageCapPerLock: number;
  /** Pieces a player may lock before inserting a commanded chunk (absorbs network latency). */
  garbageLagPieces: number;
}

export const DEFAULT_RULES: Rules = { garbageDelayMs: 500, garbageCapPerLock: 8, garbageLagPieces: 6 };

/** How many garbage rows carry a bomb. */
export type BombFrequency = "off" | "sparse" | "half" | "every";
export const BOMB_FREQUENCIES: readonly BombFrequency[] = ["off", "sparse", "half", "every"];

/**
 * Room options the host picks in the waiting room. Replicated like everything
 * else, and copied into the match at start so they can't change mid-game.
 */
export interface MatchOptions {
  bombs: BombFrequency;
  blast: BombBlast;
  /** Extra attack lines per bomb detonated (0..MAX_BOMB_BONUS). */
  bombBonus: number;
  /** Two teams (up to 5 v 5) instead of free-for-all. */
  teams: boolean;
  /**
   * How teams are formed: players pick their own ("choose"), drawn at random
   * when a series starts and kept for it ("random"), or redrawn before every
   * round ("round").
   */
  teamPick: TeamPick;
  /** Rounds in a series (1..MAX_ROUNDS). Points add up across rounds. */
  rounds: number;
  /** Listed in the public room browser (anyone can see and join). */
  listed: boolean;
  /** Room name shown in the waiting room and the room browser ("" = default). */
  title: string;
}

export type TeamPick = "choose" | "random" | "round";
export const TEAM_PICKS: readonly TeamPick[] = ["choose", "random", "round"];

export const DEFAULT_MATCH_OPTIONS: MatchOptions = { bombs: "off", blast: "line", bombBonus: 1, teams: false, teamPick: "choose", rounds: 1, listed: false, title: "" };

export function cleanTitle(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 28);
}

/**
 * Validates options from the network. The bomb fields are required; the newer
 * fields fall back to defaults so partial updates and older snapshots still load.
 */
export function normalizeOptions(v: unknown): MatchOptions | null {
  if (!isObj(v)) return null;
  if (!BOMB_FREQUENCIES.includes(v.bombs as BombFrequency) || !BOMB_BLASTS.includes(v.blast as BombBlast) || !isInt(v.bombBonus, 0, MAX_BOMB_BONUS)) return null;
  if (v.teams !== undefined && !isBool(v.teams)) return null;
  if (v.teamPick !== undefined && !TEAM_PICKS.includes(v.teamPick as TeamPick)) return null;
  if (v.rounds !== undefined && !isInt(v.rounds, 1, MAX_ROUNDS)) return null;
  if (v.listed !== undefined && !isBool(v.listed)) return null;
  const title = v.title === undefined ? "" : cleanTitle(v.title);
  if (title === null) return null;
  return {
    bombs: v.bombs as BombFrequency,
    blast: v.blast as BombBlast,
    bombBonus: v.bombBonus,
    teams: (v.teams as boolean | undefined) ?? false,
    teamPick: (v.teamPick as TeamPick | undefined) ?? "choose",
    rounds: (v.rounds as number | undefined) ?? 1,
    listed: (v.listed as boolean | undefined) ?? false,
    title,
  };
}

export const isMatchOptions = (v: unknown): v is MatchOptions => normalizeOptions(v) !== null;

const cleanOptions = (v: unknown): MatchOptions => normalizeOptions(v) ?? { ...DEFAULT_MATCH_OPTIONS };

/** Bomb rows (0 = top) for a garbage chunk of `lines` rows. */
export function bombRowsFor(freq: BombFrequency, lines: number): number[] {
  if (freq === "off" || lines <= 0) return [];
  if (freq === "sparse") return [0];
  const step = freq === "half" ? 2 : 1;
  const out: number[] = [];
  for (let r = 0; r < lines; r += step) out.push(r);
  return out;
}

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
  /** Team (1 or 2), balanced on join. Only used when the room plays teams. */
  team: TeamId;
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
  /** Team in a team match, 0 in free-for-all. */
  team: number;
  /** Series points earned this round. */
  points: number;
}

export interface MatchResult {
  matchId: string;
  reason: "knockout" | "no-contest";
  /** Last player standing (free-for-all only). */
  winner: string | null;
  /** Winning team (team matches only). */
  winnerTeam: TeamId | null;
  rankings: Ranking[];
  /** 1-based round within its series. */
  round: number;
}

/** One player's running totals across a series. Kept after they leave so the final table stays complete. */
export interface SeriesStanding {
  playerId: string;
  name: string;
  team: TeamId;
  points: number;
  wins: number;
  kos: number;
  attackSent: number;
  lines: number;
  totalScore: number;
  bestScore: number;
  roundsPlayed: number;
}

export interface RoundSummary {
  matchId: string;
  reason: "knockout" | "no-contest";
  winner: string | null;
  winnerTeam: TeamId | null;
  /** player id -> [placement, points] */
  by: Record<string, [number, number]>;
}

/**
 * A run of rounds the host set up ("best of N"). Created by the first start
 * from the waiting room and finished when its last round ends (or when the
 * host takes everyone back to the waiting room early).
 */
export interface Series {
  id: string;
  total: number;
  teams: boolean;
  /** Teams were redrawn every round, so team totals mean little: rank people, not teams. */
  mixed: boolean;
  played: number;
  done: boolean;
  endedEarly: boolean;
  standings: SeriesStanding[];
  /** Rounds won by team 1 and team 2. */
  teamWins: [number, number];
  rounds: RoundSummary[];
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
  options: MatchOptions;
  /** player id -> team, for team matches (null in free-for-all). Fixed at start. */
  teams: Record<string, TeamId> | null;
  round: number;
}

export interface RoomState {
  roster: RosterEntry[];
  nextSeat: number;
  phase: Phase;
  match: MatchState | null;
  lastResult: MatchResult | null;
  closed: boolean;
  matchCounter: number;
  options: MatchOptions;
  series: Series | null;
  /** Players the host removed; they can't rejoin this room. */
  kicked: string[];
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
  | { k: "options"; options: MatchOptions }
  | { k: "team"; playerId: string; team: TeamId }
  | { k: "kick"; playerId: string }
  | { k: "next"; matchId: string; seed: number }
  | { k: "end"; reason: "no-contest" }
  | { k: "rematch" }
  | { k: "close" };

export type LogEntry = EntryBody & { seq: number; epoch: number };

export type Effect =
  | { kind: "joined"; playerId: string }
  | { kind: "left"; playerId: string; reason: "left" | "timeout" | "kicked" }
  | { kind: "presence"; playerId: string; connected: boolean }
  | { kind: "match-start"; matchId: string }
  | { kind: "go" }
  | { kind: "lock"; playerId: string; pieceIndex: number; result: LockResult }
  | { kind: "attack"; from: string; to: string; lines: number }
  | { kind: "cancel"; playerId: string; lines: number }
  | { kind: "ko"; victim: string; by: string | null; placement: number }
  | { kind: "match-end"; result: MatchResult }
  | { kind: "series-end"; series: Series }
  | { kind: "lobby" }
  | { kind: "closed" };

export type ApplyResult = { ok: true; effects: Effect[] } | { ok: false; error: string };

export function createRoomState(): RoomState {
  return { roster: [], nextSeat: 0, phase: "lobby", match: null, lastResult: null, closed: false, matchCounter: 0, options: { ...DEFAULT_MATCH_OPTIONS }, series: null, kicked: [] };
}

/** Players on a team (any role). */
export const teamSize = (s: RoomState, team: TeamId, except?: string): number => s.roster.filter((r) => r.team === team && r.playerId !== except).length;

/** Same team in a team match? (Never true in free-for-all.) */
export function teammates(m: MatchState, a: string, b: string): boolean {
  return !!m.teams && a !== b && m.teams[a] !== undefined && m.teams[a] === m.teams[b];
}

/** Did `pid` win this result (as the last player standing, or on the winning team)? */
export function wonResult(r: MatchResult, pid: string): boolean {
  if (r.reason !== "knockout") return false;
  if (r.winnerTeam !== null) return r.rankings.find((x) => x.playerId === pid)?.team === r.winnerTeam;
  return r.winner === pid;
}

export const rosterIds = (s: RoomState): string[] => s.roster.map((r) => r.playerId);
export const findRoster = (s: RoomState, pid: string): RosterEntry | undefined => s.roster.find((r) => r.playerId === pid);

function aliveOpponents(m: MatchState, pid: string): string[] {
  return m.participants.filter((p) => p !== pid && m.players[p]?.alive && !teammates(m, p, pid));
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

/**
 * Series points for one round.
 * Free-for-all: 1 per player outlasted, +2 for the win, +1 per KO.
 * Teams: +3 if your team wins, +1 if you were still standing, +1 per KO.
 */
export function roundPoints(r: { placement: number; kos: number; team: number }, n: number, winnerTeam: TeamId | null, teamsMode: boolean, reason: MatchResult["reason"]): number {
  if (reason !== "knockout") return 0;
  if (teamsMode) return r.kos + (winnerTeam !== null && r.team === winnerTeam ? 3 : 0) + (r.placement === 1 ? 1 : 0);
  return n - r.placement + (r.placement === 1 ? 2 : 0) + r.kos;
}

function rankings(m: MatchState, winnerTeam: TeamId | null, reason: MatchResult["reason"]): Ranking[] {
  const n = m.participants.length;
  return m.participants
    .map((pid) => {
      const p = m.players[pid]!;
      const r = { playerId: pid, placement: p.placement ?? 1, kos: p.kos, attackSent: p.attackSent, score: p.sim.s.score, lines: p.sim.s.lines, team: m.teams?.[pid] ?? 0, points: 0 };
      r.points = roundPoints(r, n, winnerTeam, !!m.teams, reason);
      return r;
    })
    .sort((a, b) => a.placement - b.placement || b.points - a.points || b.kos - a.kos || b.score - a.score);
}

/** Close the match with a result, and fold it into the series. */
function finishMatch(s: RoomState, m: MatchState, reason: MatchResult["reason"], winner: string | null, winnerTeam: TeamId | null, effects: Effect[]): void {
  m.result = { matchId: m.matchId, reason, winner, winnerTeam, rankings: rankings(m, winnerTeam, reason), round: m.round };
  s.phase = "ended";
  s.lastResult = m.result;
  effects.push({ kind: "match-end", result: m.result });
  const sr = s.series;
  const result = m.result;
  if (!sr || sr.done) return;
  sr.played++;
  const by: Record<string, [number, number]> = {};
  for (const r of result.rankings) {
    by[r.playerId] = [r.placement, r.points];
    let st = sr.standings.find((x) => x.playerId === r.playerId);
    if (!st) {
      const name = findRoster(s, r.playerId)?.name ?? "Player";
      st = { playerId: r.playerId, name, team: 1, points: 0, wins: 0, kos: 0, attackSent: 0, lines: 0, totalScore: 0, bestScore: 0, roundsPlayed: 0 };
      sr.standings.push(st);
    }
    const ro = findRoster(s, r.playerId);
    if (ro) {
      st.name = ro.name;
      st.team = ro.team;
    }
    if (m.teams?.[r.playerId]) st.team = m.teams[r.playerId]!;
    st.points += r.points;
    st.kos += r.kos;
    st.attackSent += r.attackSent;
    st.lines += r.lines;
    st.totalScore += r.score;
    st.bestScore = Math.max(st.bestScore, r.score);
    st.roundsPlayed++;
    if (wonResult(result, r.playerId)) st.wins++;
  }
  if (reason === "knockout" && winnerTeam !== null) sr.teamWins = winnerTeam === 1 ? [sr.teamWins[0] + 1, sr.teamWins[1]] : [sr.teamWins[0], sr.teamWins[1] + 1];
  sr.rounds.push({ matchId: m.matchId, reason, winner, winnerTeam, by });
  sortStandings(sr);
  if (sr.played >= sr.total) {
    sr.done = true;
    effects.push({ kind: "series-end", series: sr });
  }
}

/** Overall ranking: points, then round wins, KOs, attack sent, total score. */
export function sortStandings(sr: Series): void {
  sr.standings.sort((a, b) => b.points - a.points || b.wins - a.wins || b.kos - a.kos || b.attackSent - a.attackSent || b.totalScore - a.totalScore || (a.playerId < b.playerId ? -1 : 1));
}

/** The team that won a series (most round wins, then total points), or null on a tie / free-for-all. */
export function seriesWinnerTeam(sr: Series): TeamId | null {
  if (!sr.teams || sr.mixed) return null;
  const [a, b] = sr.teamWins;
  if (a !== b) return a > b ? 1 : 2;
  const pts = (t: TeamId) => sr.standings.filter((x) => x.team === t).reduce((n, x) => n + x.points, 0);
  const pa = pts(1), pb = pts(2);
  return pa === pb ? null : pa > pb ? 1 : 2;
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
  const killer = by && by !== pid && m.players[by] && !teammates(m, by, pid) ? by : null;
  mp.eliminatedBy = killer;
  if (killer) m.players[killer]!.kos++;
  effects.push({ kind: "ko", victim: pid, by: killer, placement: aliveBefore });
  const alive = m.participants.filter((p) => m.players[p]!.alive);
  if (m.teams) {
    const teamsLeft = new Set(alive.map((p) => m.teams![p]!));
    if (teamsLeft.size <= 1) {
      const winnerTeam = alive.length ? m.teams[alive[0]!]! : null;
      // Everyone still standing on the winning side shares first place.
      for (const p of alive) m.players[p]!.placement = 1;
      finishMatch(s, m, "knockout", null, winnerTeam, effects);
    }
  } else if (alive.length <= 1) {
    const winner = alive[0] ?? null;
    if (winner) m.players[winner]!.placement = 1;
    finishMatch(s, m, "knockout", winner, null, effects);
  }
}

/** Participants for a new match, or an error. Disconnected players sit it out. */
/**
 * Random, even teams for these players, drawn from the match seed so every
 * peer gets the same draw. Players are shuffled, then dealt alternately.
 */
export function drawTeams(participants: readonly string[], seed: number): Record<string, TeamId> {
  const order = [...participants];
  let rng = deriveSeed(seed, "teams");
  for (let i = order.length - 1; i > 0; i--) {
    const [j, next] = rngInt(rng, i + 1);
    rng = next;
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  // Random side for the first pick too, so the draw doesn't favour one colour.
  const [flip] = rngInt(rng, 2);
  const out: Record<string, TeamId> = {};
  order.forEach((pid, i) => (out[pid] = ((i + flip) % 2 === 0 ? 1 : 2) as TeamId));
  return out;
}

/** Will this start draw random teams? (Fresh series in "random" mode, every round in "round" mode.) */
const drawsTeams = (s: RoomState, fresh: boolean): boolean =>
  s.options.teams && (s.options.teamPick === "round" || (s.options.teamPick === "random" && (fresh || !s.series || s.series.done)));

function lineUp(s: RoomState, everyone: boolean, seed: number | null = null, fresh = !everyone): { participants: string[]; teams: Record<string, TeamId> | null } | { error: string } {
  const participants = s.roster.filter((r) => (everyone || r.role === "player") && r.connected).map((r) => r.playerId);
  if (participants.length < MIN_PLAYERS) return { error: "not-enough-players" };
  if (!s.options.teams) return { participants, teams: null };
  // A random draw always splits evenly; checking it only needs a stand-in seed.
  if (drawsTeams(s, fresh)) return { participants, teams: drawTeams(participants, seed ?? 0) };
  const teams: Record<string, TeamId> = {};
  for (const pid of participants) teams[pid] = findRoster(s, pid)!.team;
  const counts = TEAM_IDS.map((t) => participants.filter((p) => teams[p] === t).length);
  if (counts.some((c) => c === 0)) return { error: "need-both-teams" };
  if (counts.some((c) => c > MAX_TEAM_SIZE)) return { error: "team-too-big" };
  return { participants, teams };
}

/**
 * Start a match. `fresh` opens a new series; otherwise it is the next round of
 * the current one, and everyone in the room (late joiners included) plays.
 * Validates before touching anything, so a failed start leaves the state as it was.
 */
/** Why a match can't start with this line-up right now, or null if it can. */
export function lineUpProblem(s: RoomState, everyone = false): string | null {
  const lu = lineUp(s, everyone);
  return "error" in lu ? lu.error : null;
}

function beginMatch(s: RoomState, matchId: string, seed: number, fresh: boolean): ApplyResult {
  const lu = lineUp(s, !fresh, seed, fresh);
  if ("error" in lu) return { ok: false, error: lu.error };
  const { participants, teams } = lu;
  const options = cleanOptions(s.options);
  if (fresh || !s.series || s.series.done) {
    s.series = {
      id: matchId,
      total: options.rounds,
      teams: options.teams,
      mixed: options.teams && options.teamPick === "round",
      played: 0,
      done: false,
      endedEarly: false,
      standings: [],
      teamWins: [0, 0],
      rounds: [],
    };
  }
  // A drawn line-up shows in the waiting room afterwards too.
  if (teams) for (const r of s.roster) if (teams[r.playerId]) r.team = teams[r.playerId]!;
  const bombs = { blast: options.blast, bonus: options.bombBonus };
  const players: Record<string, MatchPlayer> = {};
  for (const pid of participants) {
    players[pid] = {
      sim: PlayerSim.create(deriveSeed(seed, pid), bombs),
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
  s.match = {
    matchId,
    seed: seed >>> 0,
    participants,
    players,
    rng: deriveSeed(seed, "match"),
    garbageCounter: 0,
    elapsedMs: 0,
    result: null,
    options,
    teams,
    round: s.series.played + 1,
  };
  s.matchCounter++;
  s.phase = "countdown";
  for (const r of s.roster) {
    r.ready = false;
    r.role = participants.includes(r.playerId) ? "player" : "spectator";
  }
  return { ok: true, effects: [{ kind: "match-start", matchId }] };
}

/** Remove a player from the room (forfeit if they're still in a match). */
function removePlayer(s: RoomState, pid: string, reason: "left" | "timeout" | "kicked"): ApplyResult {
  const idx = s.roster.findIndex((r) => r.playerId === pid);
  if (idx < 0) return { ok: false, error: "unknown-player" };
  s.roster.splice(idx, 1);
  const effects: Effect[] = [{ kind: "left", playerId: pid, reason }];
  if (s.match && (s.phase === "playing" || s.phase === "countdown") && s.match.players[pid]?.alive) {
    eliminate(s, s.match, pid, null, effects);
  }
  return { ok: true, effects };
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
      const chunk: CommandedGarbage = { id: `c${m.garbageCounter++}`, lines: take, holeCol: g.holeCol, from: g.from, issuedAtPiece: mp.sim.s.piecesPlaced };
      const bombRows = bombRowsFor(m.options.bombs, take);
      if (bombRows.length > 0) {
        // Any column but the hole.
        const [c, next] = rngInt(m.rng, 9);
        m.rng = next;
        chunk.bombCol = c >= g.holeCol ? c + 1 : c;
        chunk.bombRows = bombRows;
      }
      mp.commanded.push(chunk);
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
      if (s.kicked.includes(e.playerId)) return { ok: false, error: "kicked" };
      if (s.roster.length >= MAX_PLAYERS) return { ok: false, error: "full" };
      s.roster.push({
        playerId: e.playerId,
        name: e.name,
        seat: s.nextSeat++,
        role: s.phase === "lobby" ? "player" : "spectator",
        ready: false,
        connected: true,
        cosmetics: e.cosmetics,
        team: teamSize(s, 1) <= teamSize(s, 2) ? 1 : 2,
      });
      return ok({ kind: "joined", playerId: e.playerId });
    }
    case "presence": {
      const r = findRoster(s, e.playerId);
      if (!r) return { ok: false, error: "unknown-player" };
      r.connected = e.connected;
      return ok({ kind: "presence", playerId: e.playerId, connected: e.connected });
    }
    case "leave":
      return removePlayer(s, e.playerId, e.reason);
    case "kick": {
      const r = removePlayer(s, e.playerId, "kicked");
      if (r.ok && !s.kicked.includes(e.playerId)) s.kicked = [...s.kicked, e.playerId].slice(-MAX_KICKED);
      return r;
    }
    case "team": {
      const r = findRoster(s, e.playerId);
      if (!r || (s.phase !== "lobby" && s.phase !== "ended")) return { ok: false, error: "bad-team" };
      if (!isTeamId(e.team)) return { ok: false, error: "bad-team" };
      if (r.team !== e.team && teamSize(s, e.team, e.playerId) >= MAX_TEAM_SIZE) return { ok: false, error: "team-full" };
      r.team = e.team;
      return ok();
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
    case "start":
      if (s.phase !== "lobby") return { ok: false, error: "bad-phase" };
      // A start from the waiting room always opens a new series.
      return beginMatch(s, e.matchId, e.seed, true);
    case "next":
      // Next round of the current series, straight from the results screen.
      if (s.phase !== "ended" || !s.series || s.series.done) return { ok: false, error: "bad-phase" };
      return beginMatch(s, e.matchId, e.seed, false);
    case "go":
      if (s.phase !== "countdown") return { ok: false, error: "bad-phase" };
      s.phase = "playing";
      return ok({ kind: "go" });
    case "place":
      return applyPlace(s, e, rules);
    case "target": {
      const mp = s.match?.players[e.playerId];
      if (!mp) return { ok: false, error: "not-participant" };
      if (e.target && s.match && teammates(s.match, e.playerId, e.target)) return { ok: false, error: "teammate" };
      mp.targetMode = e.mode;
      mp.manualTarget = e.mode === "manual" ? e.target : null;
      return ok();
    }
    case "options": {
      if (s.phase !== "lobby") return { ok: false, error: "bad-phase" };
      const o = normalizeOptions(e.options);
      if (!o) return { ok: false, error: "bad-options" };
      s.options = o;
      return ok();
    }
    case "end": {
      if (!s.match || (s.phase !== "playing" && s.phase !== "countdown")) return { ok: false, error: "bad-phase" };
      const effects: Effect[] = [];
      finishMatch(s, s.match, "no-contest", null, null, effects);
      return { ok: true, effects };
    }
    case "rematch": {
      if (s.phase !== "ended") return { ok: false, error: "bad-phase" };
      s.phase = "lobby";
      s.match = null;
      // Back to the waiting room before the last round: the series stops here.
      if (s.series && !s.series.done) {
        s.series.done = true;
        s.series.endedEarly = true;
      }
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
              commanded: p.commanded.map((g) => ({ ...g, ...(g.bombRows ? { bombRows: [...g.bombRows] } : {}) })),
            },
          ]),
        ),
        result: s.match.result ? structuredClone(s.match.result) : null,
        options: { ...s.match.options },
        teams: s.match.teams ? { ...s.match.teams } : null,
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
    options: { ...s.options },
    series: s.series ? structuredClone(s.series) : null,
    kicked: [...s.kicked],
  };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function cleanResult(v: unknown): MatchResult | null {
  if (!isObj(v) || !isStr(v.matchId, 48) || (v.reason !== "knockout" && v.reason !== "no-contest") || !Array.isArray(v.rankings) || v.rankings.length > MAX_PLAYERS)
    throw new Error("result");
  return {
    matchId: v.matchId,
    reason: v.reason,
    winner: isPid(v.winner) ? v.winner : null,
    winnerTeam: isTeamId(v.winnerTeam) ? v.winnerTeam : null,
    rankings: v.rankings.map((r: unknown) => {
      if (!isObj(r) || !isPid(r.playerId)) throw new Error("ranking");
      return { playerId: r.playerId, placement: num(r.placement), kos: num(r.kos), attackSent: num(r.attackSent), score: num(r.score), lines: num(r.lines), team: num(r.team), points: num(r.points) };
    }),
    round: isInt(v.round, 1, 1e6) ? v.round : 1,
  };
}

function cleanSeries(v: unknown): Series | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v) || !isStr(v.id, 48) || !isInt(v.total, 1, MAX_ROUNDS) || !isInt(v.played, 0, MAX_ROUNDS) || !isBool(v.teams) || !isBool(v.done)) throw new Error("series");
  if (!Array.isArray(v.standings) || v.standings.length > 64 || !Array.isArray(v.rounds) || v.rounds.length > MAX_ROUNDS || !Array.isArray(v.teamWins)) throw new Error("series lists");
  const out: Series = {
    id: v.id,
    total: v.total,
    teams: v.teams,
    mixed: v.mixed === true,
    played: v.played,
    done: v.done,
    endedEarly: v.endedEarly === true,
    // Same key order as the state machine builds it: the state hash is over JSON.
    standings: v.standings.map((x: unknown) => {
      if (!isObj(x) || !isPid(x.playerId)) throw new Error("standing");
      return {
        playerId: x.playerId,
        name: cleanName(x.name) ?? "Player",
        team: isTeamId(x.team) ? x.team : 1,
        points: num(x.points),
        wins: num(x.wins),
        kos: num(x.kos),
        attackSent: num(x.attackSent),
        lines: num(x.lines),
        totalScore: num(x.totalScore),
        bestScore: num(x.bestScore),
        roundsPlayed: num(x.roundsPlayed),
      };
    }),
    teamWins: [0, 0],
    rounds: [],
  };
  const rounds: RoundSummary[] = v.rounds.map((x: unknown) => {
      if (!isObj(x) || !isStr(x.matchId, 48) || !isObj(x.by) || (x.reason !== "knockout" && x.reason !== "no-contest")) throw new Error("round");
      const by: Record<string, [number, number]> = {};
      for (const [pid, pp] of Object.entries(x.by)) {
        if (!isPid(pid) || !Array.isArray(pp)) throw new Error("round entry");
        by[pid] = [num(pp[0]), num(pp[1])];
      }
      return { matchId: x.matchId, reason: x.reason, winner: isPid(x.winner) ? x.winner : null, winnerTeam: isTeamId(x.winnerTeam) ? x.winnerTeam : null, by };
  });
  out.teamWins = [num(v.teamWins[0]), num(v.teamWins[1])];
  out.rounds = rounds;
  return out;
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
    return { playerId: r.playerId, name, seat: r.seat, role: r.role, ready: r.ready, connected: r.connected, cosmetics: { ...r.cosmetics }, team: isTeamId(r.team) ? r.team : 1 };
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
        commanded: (p.commanded as CommandedGarbage[]).map((g) => ({ ...g, ...(Array.isArray(g.bombRows) ? { bombRows: [...g.bombRows] } : {}) })),
        targetMode: tm,
        manualTarget: (p.manualTarget as string | null) ?? null,
        lastAttacker: (p.lastAttacker as string | null) ?? null,
        lastTarget: (p.lastTarget as string | null) ?? null,
        attackSent: Number(p.attackSent) | 0,
        attackReceived: Number(p.attackReceived) | 0,
        kos: Number(p.kos) | 0,
      };
    }
    let teams: Record<string, TeamId> | null = null;
    if (isObj(m.teams)) {
      teams = {};
      for (const pid of m.participants as string[]) {
        const t = m.teams[pid];
        if (!isTeamId(t)) throw new Error("teams");
        teams[pid] = t;
      }
    }
    match = {
      matchId: m.matchId,
      seed: m.seed,
      participants: [...(m.participants as string[])],
      players,
      rng: m.rng,
      garbageCounter: m.garbageCounter,
      elapsedMs: m.elapsedMs,
      result: m.result ? cleanResult(m.result) : null,
      options: cleanOptions(m.options),
      teams,
      round: isInt(m.round, 1, 1e6) ? m.round : 1,
    };
  }
  const kicked = Array.isArray(d.kicked) ? d.kicked.filter(isPid).slice(-MAX_KICKED) : [];
  return {
    roster: outRoster,
    nextSeat: d.nextSeat,
    phase,
    match,
    lastResult: d.lastResult ? cleanResult(d.lastResult) : null,
    closed: d.closed,
    matchCounter: d.matchCounter,
    options: cleanOptions(d.options),
    series: cleanSeries(d.series),
    kicked,
  };
}

export function stateHash(s: RoomState): number {
  return hashString(JSON.stringify(serializeState(s)));
}

// ----------------------------------------------------------- entry validation

const ENTRY_KINDS = new Set(["noop", "join", "presence", "leave", "ready", "cosmetics", "start", "go", "place", "target", "options", "team", "kick", "next", "end", "rematch", "close"]);

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
    case "next":
      return isStr(v.matchId, 48) && isInt(v.seed, 0, 0xffffffff);
    case "team":
      return isPid(v.playerId) && isTeamId(v.team);
    case "kick":
      return isPid(v.playerId);
    case "place":
      return isPid(v.playerId) && typeof v.t === "number" && Number.isFinite(v.t) && v.t >= 0 && isPlacement(v.pl);
    case "target":
      return isPid(v.playerId) && (v.mode === "random" || v.mode === "manual" || v.mode === "revenge") && (v.target === null || isPid(v.target));
    case "options":
      return isMatchOptions(v.options);
    case "end":
      return v.reason === "no-contest";
    default:
      return true;
  }
}

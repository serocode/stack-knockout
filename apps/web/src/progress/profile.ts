import { useSyncExternalStore } from "react";
import { TIERS, rewardsFor, tierForScore, type Tier } from "../cosmetics/catalog";

/**
 * Local progression, saved in localStorage ("tk.profile"). No accounts and no
 * server: it lives in this browser only. Career score drives premium unlocks;
 * stats drive achievements.
 *
 * Honesty note: localStorage is editable, so this is for fun among friends,
 * not anti-cheat. Unlocks are cosmetic only and never affect gameplay.
 */

export interface Stats {
  games: number;
  wins: number;
  kos: number;
  lines: number;
  tetrises: number;
  tspins: number;
  tspinTriples: number;
  perfectClears: number;
  maxCombo: number;
  maxB2b: number;
  bestScore: number;
  bestMatchPlayers: number;
  attackSent: number;
}

export interface Profile {
  version: 1;
  careerScore: number;
  stats: Stats;
  /** achievement id -> unlocked at (epoch ms) */
  achievements: Record<string, number>;
  /** Recent match ids already counted (dedupe on reconnect/rematch). */
  counted: string[];
}

export interface Achievement {
  id: string;
  name: string;
  desc: string;
  icon: string;
  test: (p: Profile) => boolean;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: "first-game", name: "Warm-up", desc: "Finish your first game", icon: "🎮", test: (p) => p.stats.games >= 1 },
  { id: "first-line", name: "Clean sweep", desc: "Clear your first line", icon: "🧹", test: (p) => p.stats.lines >= 1 },
  { id: "tetris", name: "Four at once", desc: "Clear 4 lines with one piece", icon: "🧱", test: (p) => p.stats.tetrises >= 1 },
  { id: "tspin", name: "Spin doctor", desc: "Clear lines with a T-Spin", icon: "🌀", test: (p) => p.stats.tspins >= 1 },
  { id: "tspin-triple", name: "Triple threat", desc: "Land a T-Spin Triple", icon: "🌪️", test: (p) => p.stats.tspinTriples >= 1 },
  { id: "perfect", name: "Spotless", desc: "Perfect clear: empty the whole board", icon: "✨", test: (p) => p.stats.perfectClears >= 1 },
  { id: "combo5", name: "Chain reaction", desc: "Reach a 5-combo", icon: "⛓️", test: (p) => p.stats.maxCombo >= 5 },
  { id: "b2b3", name: "Back to back to back", desc: "Chain 3 back-to-back clears", icon: "🔁", test: (p) => p.stats.maxB2b >= 3 },
  { id: "first-ko", name: "Knockout", desc: "Knock out another player", icon: "🥊", test: (p) => p.stats.kos >= 1 },
  { id: "ko25", name: "Heavyweight", desc: "25 knockouts in total", icon: "💥", test: (p) => p.stats.kos >= 25 },
  { id: "first-win", name: "Champion", desc: "Win a multiplayer match", icon: "🏅", test: (p) => p.stats.wins >= 1 },
  { id: "wins10", name: "Dynasty", desc: "Win 10 matches", icon: "👑", test: (p) => p.stats.wins >= 10 },
  { id: "survivor", name: "Last one standing", desc: "Win a full 6-player match", icon: "🛡️", test: (p) => p.stats.bestMatchPlayers >= 6 },
  { id: "score10k", name: "High roller", desc: "Score 10,000 in one game", icon: "📈", test: (p) => p.stats.bestScore >= 10_000 },
  { id: "score50k", name: "Untouchable", desc: "Score 50,000 in one game", icon: "🚀", test: (p) => p.stats.bestScore >= 50_000 },
  { id: "lines1000", name: "Line machine", desc: "Clear 1,000 lines in total", icon: "🏗️", test: (p) => p.stats.lines >= 1000 },
];

const EMPTY_STATS: Stats = {
  games: 0, wins: 0, kos: 0, lines: 0, tetrises: 0, tspins: 0, tspinTriples: 0, perfectClears: 0,
  maxCombo: 0, maxB2b: 0, bestScore: 0, bestMatchPlayers: 0, attackSent: 0,
};

const KEY = "tk.profile";
const num = (v: unknown, max = 1e12) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.floor(v)) : 0);

function sanitize(raw: unknown): Profile {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (r.stats && typeof r.stats === "object" ? r.stats : {}) as Record<string, unknown>;
  const stats = Object.fromEntries(Object.keys(EMPTY_STATS).map((k) => [k, num(s[k])])) as unknown as Stats;
  const ach: Record<string, number> = {};
  if (r.achievements && typeof r.achievements === "object") {
    for (const [k, v] of Object.entries(r.achievements as Record<string, unknown>)) if (ACHIEVEMENTS.some((a) => a.id === k)) ach[k] = num(v);
  }
  const counted = Array.isArray(r.counted) ? (r.counted as unknown[]).filter((x): x is string => typeof x === "string" && x.length <= 64).slice(-50) : [];
  return { version: 1, careerScore: num(r.careerScore), stats, achievements: ach, counted };
}

function load(): Profile {
  try {
    return sanitize(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    return sanitize({});
  }
}

let current = load();
const listeners = new Set<() => void>();

export type UnlockEvent =
  | { kind: "tier"; tier: Tier; rewards: { kind: string; label: string }[] }
  | { kind: "achievement"; achievement: Achievement };
const unlockListeners = new Set<(e: UnlockEvent) => void>();

function save(next: Profile): void {
  const beforeTier = tierForScore(current.careerScore);
  const before = current;
  // Award achievements reached by this update.
  const ach = { ...next.achievements };
  const newly: Achievement[] = [];
  for (const a of ACHIEVEMENTS) {
    if (!ach[a.id] && a.test(next)) {
      ach[a.id] = Date.now();
      newly.push(a);
    }
  }
  current = { ...next, achievements: ach };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable */
  }
  for (const l of listeners) l();
  const afterTier = tierForScore(current.careerScore);
  if (before !== current && afterTier.score > beforeTier.score) {
    for (const t of TIERS) if (t.score > beforeTier.score && t.score <= afterTier.score) emit({ kind: "tier", tier: t, rewards: rewardsFor(t.id) });
  }
  for (const a of newly) emit({ kind: "achievement", achievement: a });
}

function emit(e: UnlockEvent): void {
  for (const l of unlockListeners) l(e);
}

export function getProfile(): Profile {
  return current;
}

export function subscribeProfile(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useProfile(): Profile {
  return useSyncExternalStore(subscribeProfile, getProfile, getProfile);
}

export function onUnlock(fn: (e: UnlockEvent) => void): () => void {
  unlockListeners.add(fn);
  return () => unlockListeners.delete(fn);
}

/** Per-lock stats from the local board (practice and matches). */
export function recordLock(r: { lines: number; tspin: "none" | "mini" | "full"; perfectClear: boolean; combo: number; b2bBonus: boolean }, b2bChain: number): void {
  if (r.lines === 0) return;
  const s = { ...current.stats };
  s.lines += r.lines;
  if (r.lines === 4) s.tetrises++;
  if (r.tspin !== "none") s.tspins++;
  if (r.tspin === "full" && r.lines === 3) s.tspinTriples++;
  if (r.perfectClear) s.perfectClears++;
  s.maxCombo = Math.max(s.maxCombo, r.combo);
  s.maxB2b = Math.max(s.maxB2b, Math.max(0, b2bChain - 1));
  save({ ...current, stats: s });
}

/** End of a game. `id` dedupes (match id, or a practice game id). */
export function recordGame(g: { id: string; score: number; kos?: number; won?: boolean; players?: number; attackSent?: number }): void {
  if (current.counted.includes(g.id)) return;
  const s = { ...current.stats };
  s.games++;
  s.bestScore = Math.max(s.bestScore, g.score);
  s.kos += g.kos ?? 0;
  s.attackSent += g.attackSent ?? 0;
  if (g.won) {
    s.wins++;
    s.bestMatchPlayers = Math.max(s.bestMatchPlayers, g.players ?? 0);
  }
  save({ ...current, careerScore: current.careerScore + Math.max(0, Math.floor(g.score)), stats: s, counted: [...current.counted, g.id].slice(-50) });
}

export function resetProfile(): void {
  save(sanitize({}));
}

// Keep tabs in sync.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    current = load();
    for (const l of listeners) l();
  });
}

import { useSyncExternalStore } from "react";
import {
  DEFAULT_COSMETICS,
  MUSIC_TRACKS,
  SOUND_PACKS,
  THEMES,
  enforceUnlocks,
  sanitizeCosmetics,
  type Cosmetics,
  type MusicTrack,
  type SoundPack,
  type Theme,
} from "../cosmetics/catalog";
import { getProfile } from "../progress/profile";

/**
 * Everything the player customises, saved in localStorage only (no accounts).
 * A tiny external store so every component re-renders on change.
 */
export type TouchMode = "gestures" | "buttons" | "both";

export interface Prefs {
  cosmetics: Cosmetics;
  theme: Theme;
  soundPack: SoundPack;
  music: MusicTrack;
  /** 0..1 */
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  reduceMotion: boolean;
  reduceFlashing: boolean;
  haptics: boolean;
  touchMode: TouchMode;
}

export const DEFAULT_PREFS: Prefs = {
  cosmetics: DEFAULT_COSMETICS,
  theme: "midnight",
  soundPack: "arcade",
  music: "drift",
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.8,
  reduceMotion: false,
  reduceFlashing: false,
  haptics: true,
  touchMode: "both",
};

const KEY = "tk.prefs";
const vol = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
const oneOf = <T extends string>(list: readonly { id: T }[], v: unknown, d: T): T => (list.some((o) => o.id === v) ? (v as T) : d);

function sanitize(raw: unknown): Prefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const prefersReduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return {
    // Your own look can only use what you have unlocked.
    cosmetics: enforceUnlocks(sanitizeCosmetics(r.cosmetics as Partial<Record<keyof Cosmetics, unknown>>), getProfile().careerScore),
    theme: oneOf(THEMES, r.theme, DEFAULT_PREFS.theme),
    soundPack: oneOf(SOUND_PACKS, r.soundPack, DEFAULT_PREFS.soundPack),
    music: oneOf(MUSIC_TRACKS, r.music, DEFAULT_PREFS.music),
    masterVolume: vol(r.masterVolume, DEFAULT_PREFS.masterVolume),
    musicVolume: vol(r.musicVolume, DEFAULT_PREFS.musicVolume),
    sfxVolume: vol(r.sfxVolume, DEFAULT_PREFS.sfxVolume),
    reduceMotion: typeof r.reduceMotion === "boolean" ? r.reduceMotion : prefersReduced,
    reduceFlashing: typeof r.reduceFlashing === "boolean" ? r.reduceFlashing : false,
    haptics: typeof r.haptics === "boolean" ? r.haptics : true,
    touchMode: r.touchMode === "gestures" || r.touchMode === "buttons" || r.touchMode === "both" ? r.touchMode : "both",
  };
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitize(JSON.parse(raw));
    // Migrate the block skin picked in the first version's Settings.
    const old = JSON.parse(localStorage.getItem("tk.settings") ?? "{}") as { blockSkin?: string };
    return sanitize({ cosmetics: { block: old.blockSkin } });
  } catch {
    return sanitize({});
  }
}

let current: Prefs = load();
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  return current;
}

export function setPrefs(update: Partial<Prefs> | ((p: Prefs) => Partial<Prefs>)): void {
  const patch = typeof update === "function" ? update(current) : update;
  current = sanitize({ ...current, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable: keep in memory */
  }
  for (const l of listeners) l();
}

export function setCosmetics(patch: Partial<Cosmetics>): void {
  setPrefs((p) => ({ cosmetics: { ...p.cosmetics, ...patch } }));
}

export function subscribePrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
}

// Other tabs changing prefs (e.g. customising in one tab while playing in another).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    current = load();
    for (const l of listeners) l();
  });
}

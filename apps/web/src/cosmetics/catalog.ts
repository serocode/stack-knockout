/**
 * Every cosmetic option in the game. Purely presentational: nothing here is
 * ever read by the engine or the coordinator (which treats the shared subset
 * as opaque strings), so cosmetics cannot change collision, scoring, attacks
 * or balance.
 *
 * Shared with other players (they see your look): block skin + shape options,
 * palette, frame, effect, background, ghost, garbage, bomb, avatar, tier badge.
 * Local only (your own screen): UI theme, sounds, music.
 *
 * Premium items carry a `tier`; they unlock when your career score (the sum
 * of all your game scores, saved locally) reaches that tier's threshold.
 */

// ------------------------------------------------------------------ tiers

export const TIERS = [
  { id: "rookie", name: "Rookie", score: 0, color: "#8a91a6", icon: "◆" },
  { id: "bronze", name: "Bronze", score: 10_000, color: "#d08a4e", icon: "◆" },
  { id: "silver", name: "Silver", score: 40_000, color: "#c9d1e0", icon: "◆" },
  { id: "gold", name: "Gold", score: 100_000, color: "#f6c84d", icon: "◆" },
  { id: "platinum", name: "Platinum", score: 250_000, color: "#7fe3d8", icon: "◆" },
  { id: "diamond", name: "Diamond", score: 500_000, color: "#9ad7ff", icon: "◆" },
] as const;
export type TierId = (typeof TIERS)[number]["id"];
export type Tier = (typeof TIERS)[number];

export const tierById = (id: TierId): Tier => TIERS.find((t) => t.id === id)!;

export function tierForScore(score: number): Tier {
  let t: Tier = TIERS[0];
  for (const x of TIERS) if (score >= x.score) t = x;
  return t;
}

export function nextTier(score: number): Tier | null {
  return TIERS.find((t) => t.score > score) ?? null;
}

export interface Option<Id extends string = string> {
  id: Id;
  label: string;
  hint?: string;
  /** Premium: unlocks at this tier. */
  tier?: TierId;
}

export function isUnlocked(o: { tier?: TierId } | undefined, careerScore: number): boolean {
  return !o?.tier || careerScore >= tierById(o.tier).score;
}

const opts = <const T extends readonly Option[]>(list: T) => list;

// ------------------------------------------------------------------ blocks

export const BLOCK_SKINS = opts([
  { id: "classic", label: "Classic", hint: "Flat colour with a bevel" },
  { id: "neon", label: "Neon", hint: "Glowing outlines" },
  { id: "glass", label: "Glass", hint: "Translucent with a glint" },
  { id: "pixel", label: "Pixel", hint: "Chunky 8-bit bricks" },
  { id: "gradient", label: "Gradient", hint: "Two-tone fade" },
  { id: "metallic", label: "Metallic", hint: "Brushed metal sheen" },
  { id: "cyber", label: "Cyber", hint: "Circuit corners" },
  { id: "liquid", label: "Liquid", hint: "Rounded, gently shimmering" },
  { id: "candy", label: "Candy", hint: "Glossy stripes" },
  { id: "bubble", label: "Bubble", hint: "Soft round orbs" },
  { id: "outline", label: "Outline", hint: "Hollow line art" },
  { id: "retro", label: "Retro CRT", hint: "Scanlines and colour fringe" },
  { id: "paper", label: "Paper", hint: "Flat cut-outs with shadow" },
  { id: "gold", label: "Gold", hint: "Polished gold with a moving sheen", tier: "bronze" },
  { id: "lava", label: "Lava", hint: "Molten cracks that pulse", tier: "silver" },
  { id: "galaxy", label: "Galaxy", hint: "A tiny nebula in every block", tier: "gold" },
  { id: "prism", label: "Prism", hint: "Iridescent, shifting hues", tier: "platinum" },
  { id: "diamond", label: "Diamond", hint: "Faceted gems that sparkle", tier: "diamond" },
] as const);
export type BlockSkin = (typeof BLOCK_SKINS)[number]["id"];

export const BLOCK_CORNERS = opts([
  { id: "sharp", label: "Sharp" },
  { id: "soft", label: "Soft" },
  { id: "round", label: "Round" },
] as const);
export type BlockCorners = (typeof BLOCK_CORNERS)[number]["id"];

export const BLOCK_GAPS = opts([
  { id: "tight", label: "Tight" },
  { id: "normal", label: "Normal" },
  { id: "wide", label: "Wide" },
] as const);
export type BlockGap = (typeof BLOCK_GAPS)[number]["id"];

export const BLOCK_PATTERNS = opts([
  { id: "none", label: "None" },
  { id: "stripes", label: "Stripes" },
  { id: "dots", label: "Dots" },
  { id: "scanlines", label: "Scanlines" },
  { id: "checker", label: "Checker" },
  { id: "sparkle", label: "Sparkle", tier: "silver" },
] as const);
export type BlockPattern = (typeof BLOCK_PATTERNS)[number]["id"];

export const BLOCK_GLOWS = opts([
  { id: "off", label: "Off" },
  { id: "soft", label: "Soft" },
  { id: "strong", label: "Strong", tier: "bronze" },
] as const);
export type BlockGlow = (typeof BLOCK_GLOWS)[number]["id"];

// ------------------------------------------------------------------ board, frames, fx

export const FRAMES = opts([
  { id: "minimal", label: "Minimal" },
  { id: "arcade", label: "Arcade" },
  { id: "cyberpunk", label: "Cyberpunk" },
  { id: "holographic", label: "Holographic" },
  { id: "fire", label: "Fire" },
  { id: "ice", label: "Ice" },
  { id: "space", label: "Space" },
  { id: "royal", label: "Royal", hint: "Gold filigree and jewels", tier: "bronze" },
  { id: "prismatic", label: "Prismatic", hint: "Rainbow light bends around it", tier: "gold" },
  { id: "celestial", label: "Celestial", hint: "A halo of orbiting stars", tier: "diamond" },
] as const);
export type Frame = (typeof FRAMES)[number]["id"];

export const EFFECTS = opts([
  { id: "neon", label: "Neon pulse", hint: "Expanding rings" },
  { id: "lightning", label: "Lightning", hint: "Jagged bolts" },
  { id: "fire", label: "Fire explosion", hint: "Embers and heat" },
  { id: "ice", label: "Ice shatter", hint: "Crystal shards" },
  { id: "pixel", label: "Pixel burst", hint: "Square sparks" },
  { id: "cosmic", label: "Cosmic particles", hint: "Stardust trails" },
  { id: "confetti", label: "Confetti", hint: "A party in every clear", tier: "silver" },
  { id: "supernova", label: "Supernova", hint: "Blinding shockwaves", tier: "platinum" },
] as const);
export type Effect = (typeof EFFECTS)[number]["id"];

export const BACKGROUNDS = opts([
  { id: "void", label: "Void" },
  { id: "grid", label: "Grid" },
  { id: "starfield", label: "Starfield" },
  { id: "aurora", label: "Aurora" },
  { id: "circuit", label: "Circuit" },
  { id: "sunset", label: "Sunset" },
  { id: "nebula", label: "Nebula", tier: "silver" },
  { id: "embers", label: "Embers", tier: "gold" },
  { id: "matrix", label: "Code rain", tier: "platinum" },
] as const);
export type Background = (typeof BACKGROUNDS)[number]["id"];

export const GHOSTS = opts([
  { id: "translucent", label: "Translucent" },
  { id: "outline", label: "Outline" },
  { id: "dashed", label: "Dashed" },
  { id: "glow", label: "Glow" },
  { id: "off", label: "Off" },
] as const);
export type Ghost = (typeof GHOSTS)[number]["id"];

export const GARBAGES = opts([
  { id: "stone", label: "Stone" },
  { id: "crate", label: "Crate" },
  { id: "hazard", label: "Hazard stripes" },
  { id: "skin", label: "Match my skin" },
] as const);
export type Garbage = (typeof GARBAGES)[number]["id"];

/** How bomb cells look (only appear when the room host turns bombs on). */
export const BOMBS = opts([
  { id: "classic", label: "Round bomb", hint: "Black ball with a lit fuse" },
  { id: "mine", label: "Sea mine", hint: "Spikes and a blinking light" },
  { id: "dynamite", label: "Dynamite", hint: "A bundle of red sticks" },
  { id: "core", label: "Energy core", hint: "A pulsing orb of light" },
  { id: "crystal", label: "Volatile crystal", hint: "A gem that hums with energy", tier: "silver" },
  { id: "atomic", label: "Atomic", hint: "Radioactive, glowing green", tier: "gold" },
] as const);
export type Bomb = (typeof BOMBS)[number]["id"];

export const THEMES = opts([
  { id: "midnight", label: "Midnight" },
  { id: "daylight", label: "Daylight" },
  { id: "synthwave", label: "Synthwave" },
  { id: "terminal", label: "Terminal" },
  { id: "sakura", label: "Sakura" },
] as const);
export type Theme = (typeof THEMES)[number]["id"];

export const SOUND_PACKS = opts([
  { id: "arcade", label: "Arcade" },
  { id: "soft", label: "Soft" },
  { id: "chip", label: "Chiptune" },
  { id: "off", label: "Off" },
] as const);
export type SoundPack = (typeof SOUND_PACKS)[number]["id"];

export const MUSIC_TRACKS = opts([
  { id: "drift", label: "Drift", hint: "Laid-back groove" },
  { id: "overdrive", label: "Overdrive", hint: "Fast and driving" },
  { id: "nocturne", label: "Nocturne", hint: "Minor-key arpeggios" },
  { id: "off", label: "Off" },
] as const);
export type MusicTrack = (typeof MUSIC_TRACKS)[number]["id"];

export const AVATARS: readonly Option[] = [
  ...["🦊", "🐙", "🐸", "🦉", "🐼", "🐯", "🤖", "👾", "🐧", "🦄", "🐝", "🌵", "🍄", "🐢", "🦖", "🐳", "🔥", "⚡", "🌙", "🎧"].map((a) => ({ id: a, label: a })),
  { id: "🏆", label: "🏆", tier: "bronze" },
  { id: "🦁", label: "🦁", tier: "bronze" },
  { id: "🚀", label: "🚀", tier: "silver" },
  { id: "🐉", label: "🐉", tier: "gold" },
  { id: "💎", label: "💎", tier: "platinum" },
  { id: "👑", label: "👑", tier: "diamond" },
];

/** Default piece colours in engine cell order: I, O, T, S, Z, J, L. */
export const DEFAULT_PALETTE = ["#3fd7e8", "#f6d04d", "#b768f2", "#62d26f", "#f05a5a", "#4f78f4", "#f59a44"] as const;
export const PRESET_PALETTES: { id: string; label: string; colors: readonly string[]; tier?: TierId }[] = [
  { id: "default", label: "Standard", colors: DEFAULT_PALETTE },
  { id: "pastel", label: "Pastel", colors: ["#9ee6ee", "#f8e59a", "#d6b2f7", "#a8e6b0", "#f5a8a8", "#a9bdf7", "#f8c79c"] },
  { id: "vivid", label: "Vivid", colors: ["#00e5ff", "#ffea00", "#d500f9", "#00e676", "#ff1744", "#2979ff", "#ff9100"] },
  { id: "ocean", label: "Ocean", colors: ["#5ee7ff", "#8ef0d6", "#4aa3ff", "#2fd5b8", "#6c8cff", "#1f6fd1", "#99e1ff"] },
  { id: "sunset", label: "Sunset", colors: ["#ffd36b", "#ffb347", "#ff7a7a", "#ff9e6b", "#e8507a", "#b85ad6", "#ff6a3d"] },
  { id: "forest", label: "Forest", colors: ["#9be58a", "#d7e36a", "#5cbf7a", "#3d9e5f", "#c9a25b", "#6f8f4e", "#e0c27a"] },
  { id: "mono", label: "Monochrome", colors: ["#f2f2f2", "#d9d9d9", "#bfbfbf", "#a6a6a6", "#8c8c8c", "#737373", "#595959"] },
  { id: "highcontrast", label: "High contrast", colors: ["#00ffff", "#ffff00", "#ff00ff", "#00ff00", "#ff0000", "#0066ff", "#ff8800"] },
  { id: "royal", label: "Royal", colors: ["#f6d27a", "#ffe9a8", "#c48bff", "#7ad6a5", "#ff7f8e", "#7f9bff", "#ffb36b"], tier: "gold" },
];

// ------------------------------------------------------------------ the look

export interface Cosmetics {
  block: BlockSkin;
  corners: BlockCorners;
  gap: BlockGap;
  pattern: BlockPattern;
  glow: BlockGlow;
  /** 7 colours, I O T S Z J L. */
  palette: string[];
  frame: Frame;
  effect: Effect;
  background: Background;
  ghost: Ghost;
  garbage: Garbage;
  bomb: Bomb;
  avatar: string;
}

export const DEFAULT_COSMETICS: Cosmetics = {
  block: "classic",
  corners: "sharp",
  gap: "normal",
  pattern: "none",
  glow: "off",
  palette: [...DEFAULT_PALETTE],
  frame: "minimal",
  effect: "neon",
  background: "grid",
  ghost: "translucent",
  garbage: "stone",
  bomb: "classic",
  avatar: "🦊",
};

const HEX = /^#[0-9a-f]{6}$/i;
const pick = <T extends string>(list: readonly Option<T>[], v: unknown, fallback: T): T =>
  list.some((o) => o.id === v) ? (v as T) : fallback;

export function sanitizePalette(v: unknown): string[] {
  if (Array.isArray(v) && v.length === 7 && v.every((c) => typeof c === "string" && HEX.test(c))) return v.map((c: string) => c.toLowerCase());
  return [...DEFAULT_PALETTE];
}

export function sanitizeAvatar(v: unknown): string {
  return typeof v === "string" && AVATARS.some((a) => a.id === v) ? v : DEFAULT_COSMETICS.avatar;
}

export function sanitizeCosmetics(v: Partial<Record<keyof Cosmetics, unknown>> | null | undefined): Cosmetics {
  const c = v ?? {};
  return {
    block: pick(BLOCK_SKINS, c.block, DEFAULT_COSMETICS.block),
    corners: pick(BLOCK_CORNERS, c.corners, DEFAULT_COSMETICS.corners),
    gap: pick(BLOCK_GAPS, c.gap, DEFAULT_COSMETICS.gap),
    pattern: pick(BLOCK_PATTERNS, c.pattern, DEFAULT_COSMETICS.pattern),
    glow: pick(BLOCK_GLOWS, c.glow, DEFAULT_COSMETICS.glow),
    palette: sanitizePalette(c.palette),
    frame: pick(FRAMES, c.frame, DEFAULT_COSMETICS.frame),
    effect: pick(EFFECTS, c.effect, DEFAULT_COSMETICS.effect),
    background: pick(BACKGROUNDS, c.background, DEFAULT_COSMETICS.background),
    ghost: pick(GHOSTS, c.ghost, DEFAULT_COSMETICS.ghost),
    garbage: pick(GARBAGES, c.garbage, DEFAULT_COSMETICS.garbage),
    bomb: pick(BOMBS, c.bomb, DEFAULT_COSMETICS.bomb),
    avatar: sanitizeAvatar(c.avatar),
  };
}

/** Replace anything the player hasn't unlocked with the default (for their OWN look). */
export function enforceUnlocks(c: Cosmetics, careerScore: number): Cosmetics {
  const ok = <T extends string>(list: readonly Option<T>[], id: T, d: T): T => (isUnlocked(list.find((o) => o.id === id), careerScore) ? id : d);
  const pal = PRESET_PALETTES.find((p) => p.colors.join() === c.palette.join());
  return {
    ...c,
    block: ok(BLOCK_SKINS, c.block, DEFAULT_COSMETICS.block),
    pattern: ok(BLOCK_PATTERNS, c.pattern, DEFAULT_COSMETICS.pattern),
    glow: ok(BLOCK_GLOWS, c.glow, DEFAULT_COSMETICS.glow),
    frame: ok(FRAMES, c.frame, DEFAULT_COSMETICS.frame),
    effect: ok(EFFECTS, c.effect, DEFAULT_COSMETICS.effect),
    background: ok(BACKGROUNDS, c.background, DEFAULT_COSMETICS.background),
    bomb: ok(BOMBS, c.bomb, DEFAULT_COSMETICS.bomb),
    avatar: ok(AVATARS, c.avatar, DEFAULT_COSMETICS.avatar),
    palette: pal && !isUnlocked(pal, careerScore) ? [...DEFAULT_PALETTE] : c.palette,
  };
}

/** Compact string map sent to peers (fits the coordinator's 16 keys x 64 chars limit). */
export function toWire(c: Cosmetics, tier?: TierId): Record<string, string> {
  return {
    block: c.block,
    cor: c.corners,
    gap: c.gap,
    pat: c.pattern,
    glw: c.glow,
    pal: c.palette.map((h) => h.slice(1)).join(""),
    frame: c.frame,
    fx: c.effect,
    bg: c.background,
    ghost: c.ghost,
    garb: c.garbage,
    bmb: c.bomb,
    av: c.avatar,
    ...(tier ? { tier } : {}),
  };
}

/** Peer cosmetics are untrusted: anything unknown falls back to defaults. */
export function fromWire(w: Record<string, string> | undefined): Cosmetics {
  const pal = w?.pal && /^[0-9a-f]{42}$/i.test(w.pal) ? Array.from({ length: 7 }, (_, i) => `#${w.pal!.slice(i * 6, i * 6 + 6)}`) : undefined;
  return sanitizeCosmetics({
    block: w?.block,
    corners: w?.cor,
    gap: w?.gap,
    pattern: w?.pat,
    glow: w?.glw,
    palette: pal,
    frame: w?.frame,
    effect: w?.fx,
    background: w?.bg,
    ghost: w?.ghost,
    garbage: w?.garb,
    bomb: w?.bmb,
    avatar: w?.av,
  });
}

/** A peer's self-reported tier badge (cosmetic, unverifiable). */
export function tierFromWire(w: Record<string, string> | undefined): Tier {
  return TIERS.find((t) => t.id === w?.tier) ?? TIERS[0];
}

export function labelOf(list: readonly Option[], id: string): string {
  return list.find((o) => o.id === id)?.label ?? id;
}

/** Everything a tier unlocks, for the profile screen. */
export function rewardsFor(tier: TierId): { kind: string; label: string }[] {
  const out: { kind: string; label: string }[] = [];
  const add = (kind: string, list: readonly Option[]) => list.filter((o) => o.tier === tier).forEach((o) => out.push({ kind, label: o.label }));
  add("Block skin", BLOCK_SKINS);
  add("Frame", FRAMES);
  add("Effect", EFFECTS);
  add("Background", BACKGROUNDS);
  add("Pattern", BLOCK_PATTERNS);
  add("Glow", BLOCK_GLOWS);
  add("Bomb", BOMBS);
  add("Avatar", AVATARS);
  PRESET_PALETTES.filter((p) => p.tier === tier).forEach((p) => out.push({ kind: "Colours", label: p.label }));
  return out;
}

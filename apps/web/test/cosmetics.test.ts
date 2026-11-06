import { describe, expect, it } from "vitest";
import { isCosmetics } from "@tk/coordinator";
import { AVATARS, BACKGROUNDS, BLOCK_SKINS, BOMBS, DEFAULT_COSMETICS, EFFECTS, FRAMES, GARBAGES, GHOSTS, PRESET_PALETTES, TIERS, enforceUnlocks, fromWire, isUnlocked, sanitizeCosmetics, tierForScore, tierFromWire, toWire, type Cosmetics } from "../src/cosmetics/catalog";
import { ACHIEVEMENTS, getProfile, onUnlock, recordGame, recordLock, resetProfile, sanitizeProfile, type UnlockEvent } from "../src/progress/profile";

describe("cosmetics wire format", () => {
  it("every combination round-trips and fits the coordinator's opaque cosmetics limits", () => {
    for (const block of BLOCK_SKINS)
      for (const frame of FRAMES)
        for (const effect of EFFECTS) {
          const c: Cosmetics = {
            block: block.id,
            frame: frame.id,
            effect: effect.id,
            background: BACKGROUNDS[(block.id.length + frame.id.length) % BACKGROUNDS.length]!.id,
            ghost: GHOSTS[effect.id.length % GHOSTS.length]!.id,
            garbage: GARBAGES[frame.id.length % GARBAGES.length]!.id,
            bomb: BOMBS[block.id.length % BOMBS.length]!.id,
            palette: [...PRESET_PALETTES[block.id.length % PRESET_PALETTES.length]!.colors],
            avatar: AVATARS[effect.id.length % AVATARS.length]!.id,
            corners: "soft",
            gap: "wide",
            pattern: "dots",
            glow: "soft",
          };
          const wire = toWire(c, "gold");
          expect(isCosmetics(wire)).toBe(true);
          expect(fromWire(wire)).toEqual(sanitizeCosmetics(c));
        }
  });

  it("untrusted peer values fall back to safe defaults", () => {
    const evil = fromWire({ block: "<script>", pal: "zz".repeat(21), frame: "../../etc", fx: "", bg: "x", ghost: "y", garb: "z", av: "💣💣💣" });
    expect(evil).toEqual(sanitizeCosmetics({}));
    expect(fromWire(undefined)).toEqual(sanitizeCosmetics({}));
  });
});

describe("premium unlocks", () => {
  it("every premium item belongs to a real tier above Rookie", () => {
    for (const list of [BLOCK_SKINS, FRAMES, EFFECTS, BACKGROUNDS, BOMBS, AVATARS])
      for (const o of list as readonly { tier?: string }[]) if (o.tier) expect(TIERS.slice(1).map((t) => t.id)).toContain(o.tier);
  });

  it("locked items cannot be equipped, unlocked ones stay", () => {
    const wanted: Cosmetics = { ...DEFAULT_COSMETICS, block: "diamond", frame: "royal", effect: "supernova", background: "nebula", avatar: "👑", glow: "strong" };
    expect(enforceUnlocks(wanted, 0)).toEqual({ ...DEFAULT_COSMETICS });
    const rich = enforceUnlocks(wanted, 1_000_000);
    expect(rich.block).toBe("diamond");
    expect(rich.avatar).toBe("👑");
    const mid = enforceUnlocks(wanted, 45_000); // Silver
    expect(mid.frame).toBe("royal");
    expect(mid.background).toBe("nebula");
    expect(mid.block).toBe(DEFAULT_COSMETICS.block);
    expect(mid.effect).toBe(DEFAULT_COSMETICS.effect);
  });

  it("tier thresholds", () => {
    expect(tierForScore(0).id).toBe("rookie");
    expect(tierForScore(9_999).id).toBe("rookie");
    expect(tierForScore(10_000).id).toBe("bronze");
    expect(tierForScore(500_000).id).toBe("diamond");
    expect(isUnlocked(BLOCK_SKINS.find((b) => b.id === "gold"), 10_000)).toBe(true);
    expect(tierFromWire({ tier: "gold" }).id).toBe("gold");
    expect(tierFromWire({ tier: "god-mode" }).id).toBe("rookie");
  });
});

describe("career progression", () => {
  it("adds scores once per game, fires tier and achievement unlocks once", () => {
    resetProfile();
    const events: UnlockEvent[] = [];
    const off = onUnlock((e) => events.push(e));
    recordGame({ id: "m1", score: 6_000 });
    recordGame({ id: "m1", score: 6_000 }); // duplicate (reconnect / re-render)
    expect(getProfile().careerScore).toBe(6_000);
    expect(events.filter((e) => e.kind === "tier")).toHaveLength(0);
    recordGame({ id: "m2", score: 38_000, won: true, players: 6, kos: 3 });
    expect(getProfile().careerScore).toBe(44_000);
    const tiers = events.filter((e) => e.kind === "tier").map((e) => (e.kind === "tier" ? e.tier.id : ""));
    expect(tiers).toEqual(["bronze", "silver"]);
    const ach = new Set(events.filter((e) => e.kind === "achievement").map((e) => (e.kind === "achievement" ? e.achievement.id : "")));
    for (const id of ["first-game", "first-win", "survivor", "first-ko", "score10k"]) expect(ach.has(id)).toBe(true);
    recordLock({ lines: 4, tspin: "none", perfectClear: true, combo: 5, b2bBonus: true }, 4);
    expect(getProfile().stats.quads).toBe(1);
    expect(getProfile().achievements.perfect).toBeGreaterThan(0);
    expect(getProfile().achievements.b2b3).toBeGreaterThan(0);
    const before = events.length;
    recordLock({ lines: 4, tspin: "none", perfectClear: true, combo: 5, b2bBonus: true }, 4);
    expect(events.length).toBe(before); // nothing new to announce
    expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(15);
    off();
    resetProfile();
  });
});

describe("profile migration", () => {
  it("keeps 4-line stats and the achievement from saves made before the rename", () => {
    const p = sanitizeProfile({ careerScore: 12_000, stats: { tetrises: 7, lines: 90 }, achievements: { tetris: 1700000000000, bogus: 1 } });
    expect(p.stats.quads).toBe(7);
    expect(p.stats.lines).toBe(90);
    expect(p.achievements).toEqual({ quad: 1700000000000 });
  });
});

import { Coordinator } from "@tk/coordinator";
import { botPlacement, hashString, spawnPos, type Placement } from "@tk/engine";
import { Mesh, SimNetwork, newPlayerId, realClock } from "@tk/net";
import { AVATARS, BLOCK_SKINS, DEFAULT_COSMETICS, EFFECTS, FRAMES, PRESET_PALETTES, toWire, type Cosmetics } from "../cosmetics/catalog";

export type CpuLevel = "easy" | "medium" | "hard" | "expert";

/** Pace (ms per piece) and accuracy (chance of the best placement) per level. */
export const CPU_LEVELS: Record<CpuLevel, { label: string; pieceMs: number; skill: number }> = {
  easy: { label: "Easy", pieceMs: 1500, skill: 0.6 },
  medium: { label: "Medium", pieceMs: 900, skill: 0.85 },
  hard: { label: "Hard", pieceMs: 520, skill: 0.95 },
  expert: { label: "Expert", pieceMs: 300, skill: 1 },
};
export const isCpuLevel = (v: unknown): v is CpuLevel => typeof v === "string" && v in CPU_LEVELS;

export const MAX_CPU = 5;
const NAMES = ["Byte", "Glitch", "Pixel", "Turbo", "Widget", "Sprocket", "Nibble", "Gizmo"];
const BOT_AVATARS = ["🤖", "👾", "⚡", "🔥", "🌙", "🦖", "🐙", "🐯"];
/** Only cosmetics anyone can use (no tier unlock), so bots never flaunt rewards. */
const FREE = <T extends object>(l: readonly T[]): T[] => l.filter((o) => !("tier" in o && o.tier));

interface Bot {
  name: string;
  coord: Coordinator;
  rng: number;
  readyAskedAt: number;
  /** Piece index the current plan is for (-1 = none). */
  planIdx: number;
  /** When to show the piece over its target column, and when to lock it. */
  showAt: number;
  dueAt: number;
  plan: Placement | null;
  planHash: number;
}

const pickOf = <T,>(list: readonly T[], seed: number): T => list[seed % list.length]!;

function botLook(seed: number): Record<string, string> {
  const c: Cosmetics = {
    ...DEFAULT_COSMETICS,
    block: pickOf(FREE(BLOCK_SKINS), seed).id,
    frame: pickOf(FREE(FRAMES), seed >>> 3).id,
    effect: pickOf(FREE(EFFECTS), seed >>> 6).id,
    palette: [...pickOf(FREE(PRESET_PALETTES), seed >>> 9).colors],
    avatar: pickOf(BOT_AVATARS.filter((a) => AVATARS.some((o) => o.id === a)), seed >>> 12),
  };
  return toWire(c);
}

/**
 * Computer opponents: real Coordinators on an in-memory network in this tab,
 * driven by the engine's heuristic bot. The human's coordinator joins the same
 * network as host, so the whole match (garbage, KOs, results) runs the normal
 * production code path.
 */
export class CpuOpponents {
  readonly net = new SimNetwork(realClock, { latencyMs: 8, linkTimeoutMs: 10_000 });
  private bots: Bot[] = [];
  private timer: number;
  private nameSeq = 0;
  private closed = false;

  constructor(
    private readonly roomId: string,
    private readonly secret: string,
    public level: CpuLevel,
    count: number,
  ) {
    this.timer = window.setInterval(() => this.tick(), 40);
    // Let the host's coordinator come up first.
    window.setTimeout(() => {
      for (let i = 0; i < count; i++) this.add();
    }, 50);
  }

  get count(): number {
    return this.bots.length;
  }

  isBot(pid: string): boolean {
    return this.bots.some((b) => b.coord.playerId === pid);
  }

  add(): boolean {
    if (this.closed || this.bots.length >= MAX_CPU) return false;
    const used = new Set(this.bots.map((b) => b.name));
    let name = NAMES[this.nameSeq++ % NAMES.length]!;
    for (let i = 0; used.has(name) && i < NAMES.length; i++) name = NAMES[this.nameSeq++ % NAMES.length]!;
    const pid = newPlayerId();
    const mesh = new Mesh({ transport: this.net.createTransport(`cpu-${pid}`), clock: realClock, roomId: this.roomId, secret: this.secret, playerId: pid });
    const seed = hashString(pid) >>> 0;
    const coord = new Coordinator({ mesh, clock: realClock, name, create: false, cosmetics: botLook(seed) });
    this.bots.push({ name, coord, rng: seed || 1, readyAskedAt: -Infinity, planIdx: -1, showAt: 0, dueAt: 0, plan: null, planHash: 0 });
    return true;
  }

  /** Removes the most recently added bot (lobby only, or it forfeits). */
  remove(): void {
    const b = this.bots.pop();
    b?.coord.leave();
  }

  setLevel(level: CpuLevel): void {
    this.level = level;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.clearInterval(this.timer);
    for (const b of this.bots) void b.coord.destroy();
    this.bots = [];
    // Give the host's mesh a moment to close before stopping the network timer.
    window.setTimeout(() => this.net.dispose(), 500);
  }

  private tick(): void {
    const now = performance.now();
    const lvl = CPU_LEVELS[this.level];
    for (const b of this.bots) {
      const v = b.coord.view();
      if (v.phase === "lobby") {
        const me = v.state?.roster.find((r) => r.playerId === b.coord.playerId);
        if (me && !me.ready && now - b.readyAskedAt > 1000) {
          b.readyAskedAt = now;
          b.coord.setReady(true);
        }
        b.planIdx = -1;
        continue;
      }
      const sim = v.localSim;
      if (v.paused || !sim || sim.s.toppedOut) continue;
      const idx = sim.s.piecesPlaced;
      if (b.planIdx !== idx) {
        // Human-ish rhythm: ±30% around the level's pace.
        const delay = lvl.pieceMs * (0.7 + 0.6 * ((hashString(`${b.coord.playerId}:${idx}`) % 1000) / 1000));
        b.planIdx = idx;
        b.plan = null;
        b.showAt = now + delay * 0.35;
        b.dueAt = now + delay;
      }
      if (!b.plan && now >= b.showAt) {
        const r = botPlacement(sim, b.rng, lvl.skill);
        b.rng = r.rng;
        b.plan = r.placement;
        b.planHash = sim.hash();
        // Show the piece hovering over where it's headed, so opponents read as "playing".
        if (b.plan) b.coord.publishLivePiece({ type: b.plan.type, x: b.plan.x, y: spawnPos(b.plan.type).y, rot: b.plan.rot });
      }
      if (b.plan && now >= b.dueAt) {
        // Re-plan if the board changed under us (e.g. a resync from the host).
        let p: Placement | null = b.plan;
        if (sim.hash() !== b.planHash) {
          const r = botPlacement(sim, b.rng, lvl.skill);
          b.rng = r.rng;
          p = r.placement;
        }
        b.plan = null;
        b.planIdx = -1;
        if (p) b.coord.submitPlacement(p);
      }
    }
  }
}

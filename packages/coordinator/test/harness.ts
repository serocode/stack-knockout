import { botPlacement, hashString } from "@tk/engine";
import { Mesh, SimClock, SimNetwork } from "@tk/net";
import { Coordinator, stateHash, type CoordinatorConfig, type CoordinatorEvent } from "@tk/coordinator";

export interface SimNode {
  name: string;
  pid: string;
  transportId: string;
  mesh: Mesh;
  coord: Coordinator;
  events: CoordinatorEvent[];
  skill: number;
  botEveryMs: number;
  nextBotAt: number;
  rng: number;
  bot: boolean;
}

export function pidFor(name: string): string {
  return (hashString(name).toString(16).padStart(8, "0") + hashString(name + "!").toString(16).padStart(8, "0")).slice(0, 16);
}

/**
 * A cluster of real Coordinators + Meshes on a simulated network with a
 * virtual clock. Bots drive each local player through the same
 * submitPlacement() path the UI uses.
 */
export class Cluster {
  readonly clock = new SimClock();
  readonly net: SimNetwork;
  readonly nodes = new Map<string, SimNode>();
  private gen = new Map<string, number>();
  readonly secret = "SECRETKEY1";

  constructor(
    readonly config: Partial<CoordinatorConfig> = {},
    latencyMs = 25,
  ) {
    this.net = new SimNetwork(this.clock, { latencyMs, linkTimeoutMs: 10_000 });
  }

  add(name: string, opts: { create?: boolean; skill?: number; botEveryMs?: number; hostIfAloneAfterMs?: number } = {}): SimNode {
    const g = (this.gen.get(name) ?? 0) + 1;
    this.gen.set(name, g);
    const transportId = `${name}#${g}`;
    const pid = pidFor(name);
    const mesh = new Mesh({ transport: this.net.createTransport(transportId), clock: this.clock, roomId: "ROOM42", secret: this.secret, playerId: pid });
    const coord = new Coordinator({
      mesh,
      clock: this.clock,
      name,
      create: opts.create ?? false,
      config: this.config,
      ...(opts.hostIfAloneAfterMs !== undefined ? { hostIfAloneAfterMs: opts.hostIfAloneAfterMs } : {}),
    });
    const node: SimNode = {
      name,
      pid,
      transportId,
      mesh,
      coord,
      events: [],
      skill: opts.skill ?? 0.95,
      botEveryMs: opts.botEveryMs ?? 260 + ((hashString(name) % 7) * 20),
      nextBotAt: 0,
      rng: hashString(name) || 1,
      bot: true,
    };
    coord.on((e) => node.events.push(e));
    this.nodes.set(name, node);
    return node;
  }

  get(name: string): SimNode {
    const n = this.nodes.get(name);
    if (!n) throw new Error(`no node ${name}`);
    return n;
  }

  /** Advance virtual time, letting bots play. */
  run(ms: number, step = 20): void {
    const end = this.clock.now() + ms;
    while (this.clock.now() < end) {
      this.clock.advance(Math.min(step, end - this.clock.now()));
      this.playBots();
    }
  }

  /** Run until predicate holds (or fail after maxMs). */
  runUntil(pred: () => boolean, maxMs = 30_000, step = 20): number {
    const start = this.clock.now();
    while (!pred()) {
      if (this.clock.now() - start > maxMs) throw new Error(`condition not reached within ${maxMs}ms`);
      this.clock.advance(step);
      this.playBots();
    }
    return this.clock.now() - start;
  }

  private playBots(): void {
    const now = this.clock.now();
    for (const n of this.nodes.values()) {
      if (!n.bot || now < n.nextBotAt) continue;
      const v = n.coord.view();
      if (v.mode === "left" || v.paused || !v.localSim || v.localSim.s.toppedOut) continue;
      n.nextBotAt = now + n.botEveryMs;
      const r = botPlacement(v.localSim, n.rng, n.skill);
      n.rng = r.rng;
      if (r.placement) n.coord.submitPlacement(r.placement);
    }
  }

  /** Create a room with `names[0]` as creator and everyone else joined and ready. */
  lobby(names: string[], skills: Record<string, number> = {}): void {
    names.forEach((name, i) => this.add(name, { create: i === 0, skill: skills[name] ?? 0.95 }));
    this.runUntil(() => names.every((n) => this.get(n).coord.view().state?.roster.length === names.length), 10_000);
    for (const n of names.slice(1)) this.get(n).coord.setReady(true);
    this.runUntil(() => this.get(names[0]!).coord.canStart().ok, 5000);
  }

  startMatch(host: string): void {
    if (!this.get(host).coord.startMatch()) throw new Error("start failed: " + this.get(host).coord.canStart().reason);
    this.runUntil(() => this.alive().every((n) => n.coord.view().phase === "playing" && !n.coord.view().paused), 10_000);
  }

  /** Nodes that have not left / been removed from the test. */
  alive(): SimNode[] {
    return [...this.nodes.values()].filter((n) => n.coord.view().mode !== "left");
  }

  hosts(nodes = this.alive()): SimNode[] {
    return nodes.filter((n) => n.coord.view().mode === "host");
  }

  /** Silent connectivity loss (no close event; peers must detect via heartbeats). */
  goOffline(name: string): void {
    this.net.setOnline(this.get(name).transportId, false);
  }

  goOnline(name: string): void {
    this.net.setOnline(this.get(name).transportId, true);
  }

  /** Tab closed. graceful=true means pagehide managed to send "leaving". */
  closeTab(name: string, graceful: boolean): void {
    const n = this.get(name);
    n.bot = false;
    if (graceful) n.coord.leave();
    else void n.coord.destroy();
    this.nodes.delete(name);
  }

  /** Same player opens the invite again (new transport, same identity). */
  rejoin(name: string, opts: { skill?: number; hostIfAloneAfterMs?: number } = {}): SimNode {
    return this.add(name, { create: false, skill: opts.skill, ...(opts.hostIfAloneAfterMs !== undefined ? { hostIfAloneAfterMs: opts.hostIfAloneAfterMs } : {}) });
  }

  /** All given nodes agree on epoch, host, last seq and state hash. */
  consistent(nodes = this.alive()): boolean {
    if (nodes.length === 0) return true;
    const ref = nodes[0]!.coord;
    const rv = ref.view();
    if (!rv.state) return false;
    const h = stateHash(rv.state);
    return nodes.every((n) => {
      const v = n.coord.view();
      return v.state !== null && v.epoch === rv.epoch && v.hostId === rv.hostId && v.lastSeq === rv.lastSeq && stateHash(v.state) === h;
    });
  }

  /** Stop bots and let in-flight traffic settle, then check consistency. */
  settle(ms = 1500): void {
    const saved = [...this.nodes.values()].map((n) => [n, n.bot] as const);
    for (const n of this.nodes.values()) n.bot = false;
    this.run(ms);
    for (const [n, b] of saved) n.bot = b;
  }
}

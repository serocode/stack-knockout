import { botPlacement, hashString } from "@tk/engine";
import { Mesh, SimClock, SimNetwork } from "@tk/net";
import { Coordinator } from "@tk/coordinator";

export interface LabNode {
  name: string;
  pid: string;
  transportId: string;
  coord: Coordinator;
  online: boolean;
  closed: boolean;
  nextBotAt: number;
  rng: number;
  skill: number;
}

const pidFor = (name: string) =>
  (hashString(name).toString(16).padStart(8, "0") + hashString(name + "!").toString(16).padStart(8, "0")).slice(0, 16);

/**
 * Six real Coordinators on an in-memory network, with bots playing.
 * Everything above the transport is the production code path.
 */
export class LabCluster {
  readonly clock = new SimClock();
  readonly net = new SimNetwork(this.clock, { latencyMs: 40, linkTimeoutMs: 10_000 });
  readonly nodes: LabNode[] = [];
  readonly log: string[] = [];
  private gen = new Map<string, number>();

  constructor(readonly names: string[]) {
    names.forEach((n, i) => this.spawn(n, i === 0, i < 2 ? 0.9 : 0.6));
  }

  private spawn(name: string, create: boolean, skill: number): LabNode {
    const g = (this.gen.get(name) ?? 0) + 1;
    this.gen.set(name, g);
    const transportId = `${name}#${g}`;
    const pid = pidFor(name);
    const mesh = new Mesh({ transport: this.net.createTransport(transportId), clock: this.clock, roomId: "LAB", secret: "LABSECRET1", playerId: pid });
    const coord = new Coordinator({ mesh, clock: this.clock, name, create });
    const node: LabNode = { name, pid, transportId, coord, online: true, closed: false, nextBotAt: 0, rng: hashString(name) || 1, skill };
    coord.on((e) => {
      const t = (this.clock.now() / 1000).toFixed(1);
      const nm = (p: string | null) => this.nodes.find((n) => n.pid === p)?.name ?? "?";
      if (e.kind === "host-changed" && e.hostId === pid) this.note(`${t}s  ${name} became host (epoch ${e.epoch}${e.recoveredFrom && e.recoveredFrom !== pid ? `, recovered state from ${nm(e.recoveredFrom)}` : ""})`);
      if (e.kind === "migration-start") this.note(`${t}s  ${name}: ${e.reason}`);
      if (e.kind === "match-abandoned") this.note(`${t}s  ${name}: match abandoned (no result)`);
      if (e.kind === "effect" && e.effect.kind === "ko" && coord.view().isHost) this.note(`${t}s  KO: ${nm(e.effect.victim)} (#${e.effect.placement})`);
      if (e.kind === "effect" && e.effect.kind === "match-end" && coord.view().isHost) this.note(`${t}s  winner: ${nm(e.effect.result.winner)}`);
    });
    const idx = this.nodes.findIndex((n) => n.name === name);
    if (idx >= 0) this.nodes[idx] = node;
    else this.nodes.push(node);
    return node;
  }

  private note(s: string): void {
    this.log.unshift(s);
    if (this.log.length > 40) this.log.pop();
  }

  step(ms: number): void {
    const end = this.clock.now() + ms;
    while (this.clock.now() < end) {
      this.clock.advance(Math.min(20, end - this.clock.now()));
      this.bots();
    }
  }

  private bots(): void {
    const now = this.clock.now();
    for (const n of this.nodes) {
      if (n.closed || now < n.nextBotAt) continue;
      const v = n.coord.view();
      if (v.paused || !v.localSim || v.localSim.s.toppedOut) continue;
      n.nextBotAt = now + 220 + (hashString(n.name) % 5) * 40;
      const r = botPlacement(v.localSim, n.rng, n.skill);
      n.rng = r.rng;
      if (r.placement) n.coord.submitPlacement(r.placement);
    }
  }

  autoLobby(): void {
    for (const n of this.nodes.slice(1)) n.coord.setReady(true);
  }

  host(): LabNode | undefined {
    return this.nodes.find((n) => !n.closed && n.coord.view().isHost);
  }

  setOnline(n: LabNode, online: boolean): void {
    n.online = online;
    this.net.setOnline(n.transportId, online);
    this.note(`${(this.clock.now() / 1000).toFixed(1)}s  ${n.name} ${online ? "back online" : "lost connectivity"}`);
  }

  closeTab(n: LabNode): void {
    n.closed = true;
    void n.coord.destroy();
    this.note(`${(this.clock.now() / 1000).toFixed(1)}s  ${n.name} closed the tab`);
  }

  reopen(n: LabNode): void {
    this.note(`${(this.clock.now() / 1000).toFixed(1)}s  ${n.name} reopened the invite`);
    this.spawn(n.name, false, n.skill);
  }

  partition(groups: string[][]): void {
    this.net.partition(groups.map((g) => g.map((name) => this.nodes.find((n) => n.name === name)!.transportId)));
    this.note(`${(this.clock.now() / 1000).toFixed(1)}s  partition ${groups.map((g) => g.join("+")).join(" | ")}`);
  }

  heal(): void {
    this.net.heal();
    for (const n of this.nodes) if (!n.online && !n.closed) this.setOnline(n, true);
    this.note(`${(this.clock.now() / 1000).toFixed(1)}s  network healed`);
  }
}

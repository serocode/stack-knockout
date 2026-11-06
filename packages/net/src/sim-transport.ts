import type { Clock } from "./clock.js";
import { Emitter, type Channel, type Transport, type TransportEvents } from "./transport.js";

export interface SimNetworkOptions {
  latencyMs?: number;
  /**
   * How long a silent link (peer offline or partitioned) stays "joined" before
   * the transport reports peerLeave. Mirrors WebRTC ICE consent / SCTP timeouts,
   * which are much slower than application heartbeats.
   */
  linkTimeoutMs?: number;
}

/**
 * In-memory network for deterministic tests and the in-browser migration lab.
 * Supports per-node offline, clean close, and arbitrary partitions.
 * Delivery is reliable and FIFO per link while the link is up.
 */
export class SimNetwork {
  readonly latencyMs: number;
  readonly linkTimeoutMs: number;
  private nodes = new Map<string, SimTransport>();
  private online = new Set<string>();
  private group = new Map<string, number>();
  private links = new Map<string, { up: boolean; downSince: number | null }>();
  private readonly linkTimer: number;

  constructor(
    readonly clock: Clock,
    opts: SimNetworkOptions = {},
  ) {
    this.latencyMs = opts.latencyMs ?? 30;
    this.linkTimeoutMs = opts.linkTimeoutMs ?? 10_000;
    this.linkTimer = clock.setInterval(() => this.checkLinks(), 250);
  }

  /** Stops the link checker (needed when running on the real clock). */
  dispose(): void {
    this.clock.clearInterval(this.linkTimer);
  }

  createTransport(id: string): SimTransport {
    if (this.nodes.has(id)) throw new Error(`duplicate sim node ${id}`);
    const t = new SimTransport(this, id);
    this.nodes.set(id, t);
    this.online.add(id);
    // "Signaling": connect to every reachable node.
    for (const other of this.nodes.keys()) if (other !== id && this.reachable(id, other)) this.connect(id, other);
    return t;
  }

  /** Node loses connectivity (laptop lid closed, Wi-Fi drop). Links time out later. */
  setOnline(id: string, online: boolean): void {
    if (online) {
      this.online.add(id);
      this.rediscover(id);
    } else this.online.delete(id);
  }

  /** Split the network. Nodes not listed end up in group 0. */
  partition(groups: string[][]): void {
    this.group.clear();
    groups.forEach((g, i) => g.forEach((id) => this.group.set(id, i + 1)));
  }

  heal(): void {
    this.group.clear();
    for (const id of this.nodes.keys()) this.rediscover(id);
  }

  /** Clean close: peers are told immediately (like a closed tab tearing down SCTP). */
  remove(id: string): void {
    const t = this.nodes.get(id);
    if (!t) return;
    this.nodes.delete(id);
    this.online.delete(id);
    for (const [key, link] of this.links) {
      const [a, b] = key.split("|") as [string, string];
      if (a !== id && b !== id) continue;
      this.links.delete(key);
      if (link.up) {
        const other = a === id ? b : a;
        this.clock.setTimeout(() => this.nodes.get(other)?.emitter.emit("peerLeave", id), this.latencyMs);
      }
    }
  }

  reachable(a: string, b: string): boolean {
    return this.online.has(a) && this.online.has(b) && (this.group.get(a) ?? 0) === (this.group.get(b) ?? 0);
  }

  deliver(from: string, to: string, channel: Channel, data: string): void {
    const link = this.links.get(key(from, to));
    if (!link?.up || !this.reachable(from, to)) return;
    this.clock.setTimeout(() => {
      // Re-check on arrival: packets in flight during a partition are lost.
      const l = this.links.get(key(from, to));
      if (!l?.up || !this.reachable(from, to)) return;
      this.nodes.get(to)?.emitter.emit("message", channel, data, from);
    }, this.latencyMs);
  }

  linkedPeers(id: string): string[] {
    const out: string[] = [];
    for (const [k, l] of this.links) {
      if (!l.up) continue;
      const [a, b] = k.split("|") as [string, string];
      if (a === id) out.push(b);
      else if (b === id) out.push(a);
    }
    return out;
  }

  private connect(a: string, b: string): void {
    const k = key(a, b);
    const existing = this.links.get(k);
    if (existing?.up) return;
    this.links.set(k, { up: true, downSince: null });
    this.clock.setTimeout(() => {
      this.nodes.get(a)?.emitter.emit("peerJoin", b);
      this.nodes.get(b)?.emitter.emit("peerJoin", a);
    }, this.latencyMs * 3);
  }

  private rediscover(id: string): void {
    for (const other of this.nodes.keys()) {
      if (other === id || !this.reachable(id, other)) continue;
      const l = this.links.get(key(id, other));
      if (!l || !l.up) this.connect(id, other);
      else l.downSince = null;
    }
  }

  private checkLinks(): void {
    const now = this.clock.now();
    for (const [k, l] of this.links) {
      if (!l.up) continue;
      const [a, b] = k.split("|") as [string, string];
      if (this.reachable(a, b)) {
        l.downSince = null;
        continue;
      }
      l.downSince ??= now;
      if (now - l.downSince >= this.linkTimeoutMs) {
        l.up = false;
        this.nodes.get(a)?.emitter.emit("peerLeave", b);
        this.nodes.get(b)?.emitter.emit("peerLeave", a);
      }
    }
  }
}

function key(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class SimTransport implements Transport {
  readonly emitter = new Emitter<TransportEvents>();
  constructor(
    private readonly net: SimNetwork,
    readonly selfId: string,
  ) {}

  send(channel: Channel, data: string, toPeers?: string[]): void {
    const targets = toPeers ?? this.net.linkedPeers(this.selfId);
    for (const p of targets) this.net.deliver(this.selfId, p, channel, data);
  }

  on<E extends keyof TransportEvents>(event: E, handler: TransportEvents[E]): () => void {
    return this.emitter.on(event, handler);
  }

  peers(): string[] {
    return this.net.linkedPeers(this.selfId);
  }

  async close(): Promise<void> {
    this.net.remove(this.selfId);
    this.emitter.clear();
  }
}

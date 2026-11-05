import type { Clock, TimerHandle } from "./clock.js";
import { hmacHex, randomHex, safeEqual } from "./crypto.js";
import { Emitter, type Channel, type Transport } from "./transport.js";

export interface MeshMessage {
  channel: Exclude<Channel, "auth">;
  type: string;
  payload: unknown;
  /** Authenticated player id of the sender (never taken from the payload). */
  from: string;
  id: string;
}

export interface MeshEvents {
  message: (m: MeshMessage) => void;
  peerUp: (playerId: string) => void;
  peerDown: (playerId: string, reason: "timeout" | "left") => void;
  heartbeat: (playerId: string, payload: unknown) => void;
  rejected: (transportPeer: string, reason: string) => void;
}

export interface MeshOptions {
  transport: Transport;
  clock: Clock;
  roomId: string;
  secret: string;
  playerId: string;
  heartbeatMs?: number;
  /** A peer is reported down after this long without any traffic. */
  downAfterMs?: number;
  /** Round-trip measurement interval (ping/pong on the hb channel). */
  pingMs?: number;
  getHeartbeat?: () => unknown;
}

export const MAX_BYTES: Record<Channel, number> = {
  auth: 1024,
  crit: 512 * 1024,
  state: 4096,
  hb: 2048,
  viz: 2048,
  live: 512,
};

const RATE: Record<Channel, { perSec: number; burst: number }> = {
  auth: { perSec: 5, burst: 12 },
  crit: { perSec: 60, burst: 240 },
  state: { perSec: 40, burst: 80 },
  hb: { perSec: 10, burst: 20 },
  viz: { perSec: 30, burst: 60 },
  live: { perSec: 45, burst: 90 },
};

interface PeerAuth {
  transportId: string;
  myNonce: string;
  sentHello: boolean;
  helloAttempts: number;
  claimedPid: string | null;
  verifiedPid: string | null;
  buckets: Map<Channel, { tokens: number; at: number }>;
  seen: string[];
  seenSet: Set<string>;
}

interface Binding {
  transportId: string;
  lastHeard: number;
  up: boolean;
}

const PID_RE = /^[0-9a-f]{8,64}$/;

/**
 * Authenticated full mesh on top of any Transport:
 *  - room-secret HMAC challenge/response binds transport peers to player ids
 *  - duplicate identities are rejected while the original is alive
 *  - per-channel size limits, JSON shape checks, token-bucket rate limits,
 *    message-id de-duplication on the critical channel
 *  - heartbeats and liveness (peerUp / peerDown)
 */
export class Mesh {
  readonly playerId: string;
  private readonly t: Transport;
  private readonly clock: Clock;
  private readonly roomId: string;
  private readonly secret: string;
  private readonly heartbeatMs: number;
  private readonly downAfterMs: number;
  private getHeartbeat: () => unknown;
  private readonly emitter = new Emitter<MeshEvents>();
  private readonly auth = new Map<string, PeerAuth>();
  private readonly bindings = new Map<string, Binding>();
  /** Smoothed round-trip time per player id, in ms. */
  private readonly rtts = new Map<string, number>();
  private readonly timers: TimerHandle[] = [];
  private readonly unsub: (() => void)[] = [];
  private counter = 0;
  private closed = false;
  readonly stats = { dropped: 0, rejected: 0, malformed: 0, rateLimited: 0, duplicates: 0 };

  constructor(opts: MeshOptions) {
    this.t = opts.transport;
    this.clock = opts.clock;
    this.roomId = opts.roomId;
    this.secret = opts.secret;
    this.playerId = opts.playerId;
    this.heartbeatMs = opts.heartbeatMs ?? 500;
    this.downAfterMs = opts.downAfterMs ?? 3000;
    this.getHeartbeat = opts.getHeartbeat ?? (() => null);
    this.unsub.push(
      this.t.on("peerJoin", (p) => this.onPeerJoin(p)),
      this.t.on("peerLeave", (p) => this.onPeerLeave(p)),
      this.t.on("message", (ch, d, p) => this.onRaw(ch, d, p)),
    );
    for (const p of this.t.peers()) this.onPeerJoin(p);
    this.timers.push(this.clock.setInterval(() => this.beat(), this.heartbeatMs));
    this.timers.push(this.clock.setInterval(() => this.checkLiveness(), Math.max(50, Math.floor(this.heartbeatMs / 2))));
    this.timers.push(this.clock.setInterval(() => this.ping(), opts.pingMs ?? 1000));
  }

  on<E extends keyof MeshEvents>(event: E, handler: MeshEvents[E]): () => void {
    return this.emitter.on(event, handler);
  }

  /** The layer above supplies what each heartbeat carries (epoch, host, acked seq). */
  setHeartbeatProvider(fn: () => unknown): void {
    this.getHeartbeat = fn;
  }

  /** Players currently authenticated and heard from recently. */
  connectedPlayers(): string[] {
    return [...this.bindings.entries()].filter(([, b]) => b.up).map(([pid]) => pid);
  }

  isConnected(playerId: string): boolean {
    return this.bindings.get(playerId)?.up ?? false;
  }

  lastHeard(playerId: string): number | null {
    return this.bindings.get(playerId)?.lastHeard ?? null;
  }

  /** Smoothed round-trip time to a connected player in ms, or null if not measured yet. */
  rtt(playerId: string): number | null {
    return this.isConnected(playerId) ? (this.rtts.get(playerId) ?? null) : null;
  }

  send(channel: Exclude<Channel, "auth">, type: string, payload: unknown, to?: string | string[]): void {
    if (this.closed) return;
    const pids = to === undefined ? this.connectedPlayers() : Array.isArray(to) ? to : [to];
    const targets: string[] = [];
    for (const pid of pids) {
      const b = this.bindings.get(pid);
      if (b && pid !== this.playerId) targets.push(b.transportId);
    }
    if (targets.length === 0) return;
    const data = JSON.stringify({ t: type, i: this.nextId(), p: payload });
    if (data.length > MAX_BYTES[channel]) throw new Error(`outgoing ${type} exceeds ${channel} size limit`);
    this.t.send(channel, data, targets);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.timers) this.clock.clearInterval(h);
    for (const u of this.unsub) u();
    this.emitter.clear();
    await this.t.close();
  }

  // ---------------------------------------------------------------- internals

  private nextId(): string {
    return `${this.playerId.slice(0, 6)}${(this.counter++).toString(36)}${randomHex(3)}`;
  }

  private onPeerJoin(peer: string): void {
    if (this.closed || this.auth.has(peer)) return;
    const a: PeerAuth = {
      transportId: peer,
      myNonce: randomHex(16),
      sentHello: false,
      helloAttempts: 0,
      claimedPid: null,
      verifiedPid: null,
      buckets: new Map(),
      seen: [],
      seenSet: new Set(),
    };
    this.auth.set(peer, a);
    this.sendHello(a);
  }

  private sendHello(a: PeerAuth): void {
    a.sentHello = true;
    a.helloAttempts++;
    this.t.send("auth", JSON.stringify({ t: "hello", pid: this.playerId, nonce: a.myNonce }), [a.transportId]);
    // Keep retrying (backing off) while unverified: the peer's channel may not be
    // open yet, or a reloaded tab may be waiting for its old binding to expire.
    const delay = Math.min(5000, 1000 + a.helloAttempts * 500);
    this.clock.setTimeout(() => {
      if (!this.closed && this.auth.get(a.transportId) === a && !a.verifiedPid) this.sendHello(a);
    }, delay);
  }

  private onPeerLeave(peer: string): void {
    const a = this.auth.get(peer);
    this.auth.delete(peer);
    if (!a?.verifiedPid) return;
    const b = this.bindings.get(a.verifiedPid);
    if (b && b.transportId === peer) {
      this.bindings.delete(a.verifiedPid);
      this.rtts.delete(a.verifiedPid);
      if (b.up) this.emitter.emit("peerDown", a.verifiedPid, "left");
    }
  }

  private proofFor(nonce: string, pid: string, transportId: string): string {
    return hmacHex(this.secret, `tk-auth|${this.roomId}|${nonce}|${pid}|${transportId}`);
  }

  private allow(a: PeerAuth, ch: Channel): boolean {
    const now = this.clock.now();
    const r = RATE[ch];
    const b = a.buckets.get(ch) ?? { tokens: r.burst, at: now };
    b.tokens = Math.min(r.burst, b.tokens + ((now - b.at) / 1000) * r.perSec);
    b.at = now;
    a.buckets.set(ch, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private onRaw(ch: Channel, data: string, peer: string): void {
    if (this.closed) return;
    if (typeof data !== "string" || data.length > MAX_BYTES[ch]) {
      this.stats.malformed++;
      return;
    }
    let a = this.auth.get(peer);
    if (!a) {
      // Message before join event (possible on some transports): start auth.
      this.onPeerJoin(peer);
      a = this.auth.get(peer)!;
    }
    if (!this.allow(a, ch)) {
      this.stats.rateLimited++;
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      this.stats.malformed++;
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      this.stats.malformed++;
      return;
    }
    const m = msg as Record<string, unknown>;
    if (ch === "auth") return this.onAuth(a, m);

    const pid = a.verifiedPid;
    if (!pid) {
      this.stats.dropped++;
      return;
    }
    const binding = this.bindings.get(pid);
    if (!binding || binding.transportId !== peer) {
      this.stats.dropped++;
      return;
    }
    const type = m.t;
    const id = m.i;
    if (typeof type !== "string" || type.length === 0 || type.length > 32 || typeof id !== "string" || id.length > 48) {
      this.stats.malformed++;
      return;
    }
    if (ch === "crit") {
      if (a.seenSet.has(id)) {
        this.stats.duplicates++;
        return;
      }
      a.seenSet.add(id);
      a.seen.push(id);
      if (a.seen.length > 4096) a.seenSet.delete(a.seen.shift()!);
    }
    this.touch(pid);
    if (ch === "hb") {
      if (type === "ping") return this.send("hb", "pong", m.p, pid);
      if (type === "pong") return this.onPong(pid, m.p);
      this.emitter.emit("heartbeat", pid, m.p);
      return;
    }
    this.emitter.emit("message", { channel: ch, type, payload: m.p, from: pid, id });
  }

  private onAuth(a: PeerAuth, m: Record<string, unknown>): void {
    switch (m.t) {
      case "hello": {
        const pid = m.pid;
        const nonce = m.nonce;
        if (typeof pid !== "string" || !PID_RE.test(pid) || typeof nonce !== "string" || !/^[0-9a-f]{32}$/.test(nonce)) {
          this.stats.malformed++;
          return;
        }
        if (pid === this.playerId) return this.reject(a, "self-identity");
        a.claimedPid = pid;
        const mac = this.proofFor(nonce, this.playerId, this.t.selfId);
        this.t.send("auth", JSON.stringify({ t: "proof", pid: this.playerId, mac }), [a.transportId]);
        if (!a.sentHello) this.sendHello(a);
        return;
      }
      case "proof": {
        const pid = m.pid;
        const mac = m.mac;
        if (typeof pid !== "string" || !PID_RE.test(pid) || typeof mac !== "string" || mac.length !== 64) {
          this.stats.malformed++;
          return;
        }
        if (a.verifiedPid) return;
        const expected = this.proofFor(a.myNonce, pid, a.transportId);
        if (!safeEqual(expected, mac)) return this.reject(a, "bad-proof");
        const existing = this.bindings.get(pid);
        if (existing && existing.transportId !== a.transportId && existing.up) {
          return this.reject(a, "duplicate-identity");
        }
        a.verifiedPid = pid;
        this.bindings.set(pid, { transportId: a.transportId, lastHeard: this.clock.now(), up: true });
        this.emitter.emit("peerUp", pid);
        return;
      }
      case "reject": {
        this.emitter.emit("rejected", a.transportId, typeof m.reason === "string" ? m.reason.slice(0, 40) : "unknown");
        return;
      }
      default:
        this.stats.malformed++;
    }
  }

  private reject(a: PeerAuth, reason: string): void {
    this.stats.rejected++;
    this.t.send("auth", JSON.stringify({ t: "reject", reason }), [a.transportId]);
    this.emitter.emit("rejected", a.transportId, reason);
  }

  private touch(pid: string): void {
    const b = this.bindings.get(pid);
    if (!b) return;
    b.lastHeard = this.clock.now();
    if (!b.up) {
      b.up = true;
      this.emitter.emit("peerUp", pid);
    }
  }

  private ping(): void {
    if (this.connectedPlayers().length > 0) this.send("hb", "ping", { ts: this.clock.now() });
  }

  private onPong(pid: string, p: unknown): void {
    const ts = (p as { ts?: unknown } | null)?.ts;
    if (typeof ts !== "number" || !Number.isFinite(ts)) return void this.stats.malformed++;
    const sample = this.clock.now() - ts;
    if (sample < 0 || sample > 60_000) return;
    // EWMA: steady enough to read, quick enough to show a spike.
    const prev = this.rtts.get(pid);
    this.rtts.set(pid, prev === undefined ? sample : prev * 0.7 + sample * 0.3);
  }

  private beat(): void {
    if (this.connectedPlayers().length === 0 && this.bindings.size === 0) return;
    // Heartbeat everyone bound, including peers currently marked down, so a
    // healed link is noticed from both sides.
    const targets = [...this.bindings.values()].map((b) => b.transportId);
    if (targets.length === 0) return;
    const data = JSON.stringify({ t: "hb", i: this.nextId(), p: this.getHeartbeat() });
    this.t.send("hb", data, targets);
  }

  private checkLiveness(): void {
    const now = this.clock.now();
    for (const [pid, b] of this.bindings) {
      if (b.up && now - b.lastHeard > this.downAfterMs) {
        b.up = false;
        this.rtts.delete(pid);
        this.emitter.emit("peerDown", pid, "timeout");
      }
    }
  }
}

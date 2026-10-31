import type { Clock } from "./clock.js";
import { realClock } from "./clock.js";
import { randomHex } from "./crypto.js";
import { Emitter, type Channel, type Transport, type TransportEvents } from "./transport.js";

type Frame =
  | { k: "hello"; from: string }
  | { k: "here"; from: string }
  | { k: "bye"; from: string }
  | { k: "msg"; from: string; to: string[] | null; ch: Channel; d: string };

/**
 * Same-device transport over BroadcastChannel. Lets you open up to six tabs on
 * one machine and exercise the real mesh + coordinator (including host
 * migration by closing tabs) with no internet and no signaling relay.
 */
export class BroadcastTransport implements Transport {
  readonly selfId = randomHex(8);
  private readonly emitter = new Emitter<TransportEvents>();
  private readonly bc: BroadcastChannel;
  private readonly lastSeen = new Map<string, number>();
  private readonly timer: number;

  constructor(
    roomId: string,
    private readonly clock: Clock = realClock,
    private readonly timeoutMs = 6000,
  ) {
    this.bc = new BroadcastChannel(`tk-local-${roomId}`);
    this.bc.onmessage = (ev: MessageEvent<Frame>) => this.onFrame(ev.data);
    this.post({ k: "hello", from: this.selfId });
    this.timer = clock.setInterval(() => {
      this.post({ k: "here", from: this.selfId });
      const now = clock.now();
      for (const [peer, t] of this.lastSeen) {
        if (now - t > this.timeoutMs) {
          this.lastSeen.delete(peer);
          this.emitter.emit("peerLeave", peer);
        }
      }
    }, 1000);
  }

  private post(f: Frame): void {
    this.bc.postMessage(f);
  }

  private touch(peer: string): void {
    const known = this.lastSeen.has(peer);
    this.lastSeen.set(peer, this.clock.now());
    if (!known) this.emitter.emit("peerJoin", peer);
  }

  private onFrame(f: Frame): void {
    if (!f || typeof f !== "object" || f.from === this.selfId) return;
    switch (f.k) {
      case "hello":
        this.touch(f.from);
        this.post({ k: "here", from: this.selfId });
        return;
      case "here":
        this.touch(f.from);
        return;
      case "bye":
        if (this.lastSeen.delete(f.from)) this.emitter.emit("peerLeave", f.from);
        return;
      case "msg":
        if (f.to && !f.to.includes(this.selfId)) return;
        this.touch(f.from);
        this.emitter.emit("message", f.ch, f.d, f.from);
        return;
    }
  }

  send(channel: Channel, data: string, toPeers?: string[]): void {
    this.post({ k: "msg", from: this.selfId, to: toPeers ?? null, ch: channel, d: data });
  }

  on<E extends keyof TransportEvents>(event: E, handler: TransportEvents[E]): () => void {
    return this.emitter.on(event, handler);
  }

  peers(): string[] {
    return [...this.lastSeen.keys()];
  }

  async close(): Promise<void> {
    this.post({ k: "bye", from: this.selfId });
    this.clock.clearInterval(this.timer);
    this.bc.close();
    this.emitter.clear();
  }
}

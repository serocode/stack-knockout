import { joinRoom, selfId, type MessageAction, type Room, type TurnServerConfig } from "trystero";
import { Emitter, CHANNELS, type Channel, type Transport, type TransportEvents } from "./transport.js";
import { ensureSubtleCrypto } from "./webcrypto-shim.js";

// Before any signaling runs: supply crypto.subtle on insecure pages
// (http://192.168.x.x), where browsers hide it. No-op on https/localhost.
ensureSubtleCrypto();

export interface TrysteroTransportOptions {
  appId: string;
  /** Signaling topic; derived from the room code. */
  roomId: string;
  /** Room secret. Trystero uses it to encrypt SDP offers/answers on the relay. */
  password: string;
  /** Optional TURN servers for networks where direct P2P fails. */
  turn?: TurnServerConfig[];
  /** Override the default public Nostr relays. */
  relayUrls?: string[];
}

/**
 * Relays every peer uses unless overridden in Settings. Trystero's default is
 * 5 relays picked from a long list by app id; for our app id that pick
 * included one dead relay and one that rate-limits (checked 2026-10-31), so
 * we pin relays that answered quickly instead (offchain.pub was dropped: it
 * rejects unknown keys). All peers must share at least
 * one working relay to find each other.
 */
export const DEFAULT_RELAYS = [
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
  "wss://nostr.mom",
  "wss://relay.piazza.today",
  "wss://relay.nostr.blockhenge.com",
];

/**
 * Trystero hashes topics and encrypts offers with WebCrypto. Browsers hide it
 * on insecure pages, so we install a pure-JS stand-in there (see
 * webcrypto-shim.ts). What remains is that the browser must support WebRTC.
 */
export function webrtcSignalingAvailable(): boolean {
  ensureSubtleCrypto();
  return typeof RTCPeerConnection !== "undefined" && !!globalThis.crypto?.subtle && typeof globalThis.crypto.getRandomValues === "function";
}

/** Stream id for our negotiated fast channel; Trystero's own channel takes 0/1. */
const FAST_CHANNEL_ID = 77;
/** Sent on the fast channel to prove to the peer that we have it open too. */
const PROBE = "\u0000tk-probe";

interface FastLane {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  /** We've received something on it, so the peer has created it too. */
  confirmed: boolean;
  probes: number;
  timer: ReturnType<typeof setInterval> | null;
}

/**
 * WebRTC transport using Trystero's Nostr strategy for signaling.
 * Gameplay bytes travel over WebRTC data channels; the relays only ever see
 * encrypted connection offers on the room topic.
 *
 * Trystero gives each peer one reliable, ordered data channel. The `live`
 * channel (falling-piece positions) instead gets its own negotiated
 * RTCDataChannel on the same connection, unordered with no retransmits, so a
 * lost packet costs one stale frame instead of stalling every message queued
 * behind it. Until both sides have proven they opened it (a probe round
 * trip), `live` falls back to Trystero's channel, which also keeps mixed
 * client versions working.
 */
export class TrysteroTransport implements Transport {
  readonly selfId = selfId;
  private readonly emitter = new Emitter<TransportEvents>();
  private readonly room: Room;
  private readonly actions = new Map<Channel, MessageAction<string>>();
  private readonly fast = new Map<string, FastLane>();

  constructor(opts: TrysteroTransportOptions) {
    if (!webrtcSignalingAvailable()) throw new Error("no-webrtc");
    this.room = joinRoom(
      {
        appId: opts.appId,
        password: opts.password,
        ...(opts.turn ? { turnConfig: opts.turn } : {}),
        relayConfig: { urls: opts.relayUrls?.length ? opts.relayUrls : DEFAULT_RELAYS },
      },
      opts.roomId,
      { onJoinError: (e) => console.warn("[trystero] join error", e.error) },
    );
    for (const ch of CHANNELS) {
      const action = this.room.makeAction<string>(`tk-${ch}`);
      action.onMessage = (data, ctx) => {
        if (typeof data === "string") this.emitter.emit("message", ch, data, ctx.peerId);
      };
      this.actions.set(ch, action);
    }
    this.room.onPeerJoin = (peer) => {
      this.openFastLane(peer);
      this.emitter.emit("peerJoin", peer);
    };
    this.room.onPeerLeave = (peer) => {
      this.closeFastLane(peer);
      this.emitter.emit("peerLeave", peer);
    };
  }

  send(channel: Channel, data: string, toPeers?: string[]): void {
    let targets = toPeers;
    if (channel === "live") {
      const slow: string[] = [];
      for (const peer of toPeers ?? this.peers()) {
        const lane = this.openFastLane(peer);
        if (lane?.confirmed && lane.dc.readyState === "open") {
          try {
            lane.dc.send(data);
            continue;
          } catch {
            /* fall back below */
          }
        }
        slow.push(peer);
      }
      if (slow.length === 0) return;
      targets = slow;
    }
    const action = this.actions.get(channel);
    if (!action) return;
    void action.send(data, targets ? { target: targets } : undefined).catch(() => undefined);
  }

  /** Lazily (re)create the fast channel for a peer; null if WebRTC won't give us one. */
  private openFastLane(peer: string): FastLane | null {
    const pc = (this.room.getPeers() as Record<string, RTCPeerConnection | undefined>)[peer];
    const existing = this.fast.get(peer);
    if (existing && existing.pc === pc && existing.dc.readyState !== "closed" && existing.dc.readyState !== "closing") return existing;
    if (existing) this.closeFastLane(peer);
    if (!pc || pc.connectionState === "closed" || typeof pc.createDataChannel !== "function") return null;
    let dc: RTCDataChannel;
    try {
      // Negotiated: both sides create it with the same id, so no renegotiation is needed.
      dc = pc.createDataChannel("tk-live", { negotiated: true, id: FAST_CHANNEL_ID, ordered: false, maxRetransmits: 0 });
    } catch {
      return null;
    }
    const lane: FastLane = { pc, dc, confirmed: false, probes: 0, timer: null };
    dc.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      if (!lane.confirmed) {
        lane.confirmed = true;
        // Answer once so the peer can confirm too, even if it stopped probing.
        try {
          dc.send(PROBE);
        } catch {
          /* ignore */
        }
      }
      if (e.data !== PROBE) this.emitter.emit("message", "live", e.data, peer);
    };
    const probe = () => {
      if (lane.confirmed || lane.probes >= 20) {
        if (lane.timer) clearInterval(lane.timer);
        lane.timer = null;
        return;
      }
      if (dc.readyState !== "open") return;
      lane.probes++;
      try {
        dc.send(PROBE);
      } catch {
        /* ignore */
      }
    };
    dc.onopen = probe;
    lane.timer = setInterval(probe, 500);
    this.fast.set(peer, lane);
    return lane;
  }

  private closeFastLane(peer: string): void {
    const lane = this.fast.get(peer);
    if (!lane) return;
    this.fast.delete(peer);
    if (lane.timer) clearInterval(lane.timer);
    lane.dc.onmessage = null;
    lane.dc.onopen = null;
    try {
      lane.dc.close();
    } catch {
      /* ignore */
    }
  }

  on<E extends keyof TransportEvents>(event: E, handler: TransportEvents[E]): () => void {
    return this.emitter.on(event, handler);
  }

  peers(): string[] {
    return Object.keys(this.room.getPeers());
  }

  async close(): Promise<void> {
    for (const peer of [...this.fast.keys()]) this.closeFastLane(peer);
    this.emitter.clear();
    await this.room.leave();
  }
}

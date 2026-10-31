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

/**
 * WebRTC transport using Trystero's Nostr strategy for signaling.
 * Gameplay bytes travel over WebRTC data channels; the relays only ever see
 * encrypted connection offers on the room topic.
 */
export class TrysteroTransport implements Transport {
  readonly selfId = selfId;
  private readonly emitter = new Emitter<TransportEvents>();
  private readonly room: Room;
  private readonly actions = new Map<Channel, MessageAction<string>>();

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
    this.room.onPeerJoin = (peer) => this.emitter.emit("peerJoin", peer);
    this.room.onPeerLeave = (peer) => this.emitter.emit("peerLeave", peer);
  }

  send(channel: Channel, data: string, toPeers?: string[]): void {
    const action = this.actions.get(channel);
    if (!action) return;
    void action.send(data, toPeers ? { target: toPeers } : undefined).catch(() => undefined);
  }

  on<E extends keyof TransportEvents>(event: E, handler: TransportEvents[E]): () => void {
    return this.emitter.on(event, handler);
  }

  peers(): string[] {
    return Object.keys(this.room.getPeers());
  }

  async close(): Promise<void> {
    this.emitter.clear();
    await this.room.leave();
  }
}

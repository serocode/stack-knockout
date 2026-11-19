import { schnorr } from "@noble/secp256k1";
import { randomHex, sha256, toHex, utf8 } from "./crypto.js";
import { DirectoryBase } from "./directory.js";
import { DEFAULT_RELAYS } from "./relays.js";
import { ensureSubtleCrypto } from "./webcrypto-shim.js";

/** Ephemeral event kind (20000–29999: relays forward these but don't store them). */
const KIND = 21_377;
const TAG = "stack-knockout-rooms-v1";

/**
 * Room directory over public Nostr relays. Hosts publish signed ephemeral
 * events tagged for this app; browsers subscribe to the tag. Unlike a
 * Trystero room this opens no WebRTC connections at all — it's just a
 * websocket per relay — so browsing costs nothing for the rooms listed.
 *
 * Each tab signs with a throwaway key. Signatures aren't checked on receipt:
 * the content is validated anyway and a key proves nothing about a room.
 */
export class NostrDirectory extends DirectoryBase {
  private readonly sockets = new Map<string, { ws: WebSocket | null; backoff: number; timer: ReturnType<typeof setTimeout> | null }>();
  private readonly sk: Uint8Array;
  private readonly pk: string;
  private readonly subId = `tk${randomHex(6)}`;

  constructor(relays: string[] = DEFAULT_RELAYS) {
    super();
    ensureSubtleCrypto();
    const k = schnorr.keygen();
    this.sk = k.secretKey;
    this.pk = toHex(k.publicKey);
    for (const url of relays.slice(0, 8)) {
      this.sockets.set(url, { ws: null, backoff: 2000, timer: null });
      this.connect(url);
    }
  }

  private connect(url: string): void {
    const slot = this.sockets.get(url);
    if (!slot || this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return this.retry(url);
    }
    slot.ws = ws;
    ws.onopen = () => {
      slot.backoff = 2000;
      ws.send(JSON.stringify(["REQ", this.subId, { kinds: [KIND], "#t": [TAG], since: Math.floor(Date.now() / 1000) - 20 }]));
      // Whatever we published before this relay was up never reached it.
      this.connected();
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string" || e.data.length > 8192) return;
      try {
        const m = JSON.parse(e.data) as unknown[];
        if (m[0] !== "EVENT" || m[1] !== this.subId) return;
        const ev = m[2] as { kind?: unknown; content?: unknown; created_at?: unknown };
        // Ignore stale replays from relays that keep ephemeral events briefly.
        if (ev?.kind !== KIND || typeof ev.created_at !== "number" || Date.now() / 1000 - ev.created_at > 30) return;
        this.receive(ev.content);
      } catch {
        /* not for us */
      }
    };
    ws.onclose = () => {
      if (slot.ws === ws) slot.ws = null;
      this.retry(url);
    };
    ws.onerror = () => ws.close();
  }

  private retry(url: string): void {
    const slot = this.sockets.get(url);
    if (!slot || this.closed || slot.timer) return;
    slot.timer = setTimeout(() => {
      slot.timer = null;
      this.connect(url);
    }, slot.backoff);
    slot.backoff = Math.min(60_000, slot.backoff * 2);
  }

  protected transmit(content: string): void {
    void this.sign(content).then((frame) => {
      for (const { ws } of this.sockets.values()) if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
    }).catch(() => undefined);
  }

  private async sign(content: string): Promise<string> {
    const created_at = Math.floor(Date.now() / 1000);
    const tags = [["t", TAG]];
    const id = sha256(utf8(JSON.stringify([0, this.pk, created_at, KIND, tags, content])));
    const sig = await schnorr.signAsync(id, this.sk);
    return JSON.stringify(["EVENT", { id: toHex(id), pubkey: this.pk, created_at, kind: KIND, tags, content, sig: toHex(sig) }]);
  }

  override close(): void {
    // Withdraw first (needs the sockets), then shut them.
    super.close();
    setTimeout(() => {
      for (const slot of this.sockets.values()) {
        if (slot.timer) clearTimeout(slot.timer);
        try {
          slot.ws?.send(JSON.stringify(["CLOSE", this.subId]));
          slot.ws?.close();
        } catch {
          /* already closed */
        }
      }
      this.sockets.clear();
    }, 300);
  }
}

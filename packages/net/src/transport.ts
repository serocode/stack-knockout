/**
 * The replaceable transport boundary. Everything above this line (mesh,
 * coordinator) is unaware of WebRTC, Trystero, BroadcastChannel or the
 * in-memory simulator.
 *
 * Channel priorities (logical; a transport may map them to separate
 * RTCDataChannels or multiplex them over one reliable ordered channel):
 *  - auth: room-secret challenge/response before any other traffic is accepted
 *  - crit: critical match events, elections, state sync (reliable, ordered)
 *  - state: acknowledgements and other frequent small state updates
 *  - hb:   heartbeats
 *  - viz:  non-critical visual notifications (falling piece previews, emotes)
 */
export const CHANNELS = ["auth", "crit", "state", "hb", "viz"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface TransportEvents {
  message: (channel: Channel, data: string, fromPeer: string) => void;
  peerJoin: (peer: string) => void;
  peerLeave: (peer: string) => void;
}

export interface Transport {
  /** Transport-level id. NOT the player id; the mesh binds the two after authentication. */
  readonly selfId: string;
  send(channel: Channel, data: string, toPeers?: string[]): void;
  on<E extends keyof TransportEvents>(event: E, handler: TransportEvents[E]): () => void;
  peers(): string[];
  close(): Promise<void>;
}

/** Tiny typed emitter shared by transports. */
export class Emitter<Events extends { [K in keyof Events]: (...args: never[]) => void }> {
  private handlers = new Map<keyof Events, Set<(...args: never[]) => void>>();

  on<E extends keyof Events>(event: E, handler: Events[E]): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as (...args: never[]) => void);
    return () => set!.delete(handler as (...args: never[]) => void);
  }

  emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of [...set]) (h as (...a: Parameters<Events[E]>) => void)(...args);
  }

  clear(): void {
    this.handlers.clear();
  }
}

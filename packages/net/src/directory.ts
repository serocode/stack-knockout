import { ROOM_CODE_LENGTH, SECRET_LENGTH, normalizeCode } from "./room.js";

/**
 * Public room directory ("waiting rooms").
 *
 * There is still no server: a host that ticks "list publicly" re-announces its
 * room every few seconds on a shared broadcast medium, and the room browser
 * keeps whatever it heard recently. Listings expire on their own, so a room
 * that closes (or whose host vanishes) drops off within seconds.
 *
 * A listing carries the invite key: listing a room publicly means anyone who
 * can see the directory can join it. That is the point, and the UI says so.
 * Listings are untrusted input and are validated like every other payload.
 */
export interface RoomAd {
  code: string;
  key: string;
  expiresAt: number;
  title: string;
  host: string;
  avatar: string;
  players: number;
  max: number;
  teams: boolean;
  rounds: number;
  /** Round being played (0 in the waiting room). */
  round: number;
  phase: "lobby" | "countdown" | "playing" | "ended";
  bombs: boolean;
}

export interface RoomListing extends RoomAd {
  /** Local time we last heard it. */
  seenAt: number;
}

export const DIRECTORY_ANNOUNCE_MS = 4000;
export const DIRECTORY_TTL_MS = 15_000;
const MAX_LISTINGS = 50;
const PHASES = new Set(["lobby", "countdown", "playing", "ended"]);

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const int = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
// eslint-disable-next-line no-control-regex
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim().slice(0, max);

export function parseRoomAd(v: unknown): RoomAd | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  const code = normalizeCode(str(a.code, 12) ? a.code : "", ROOM_CODE_LENGTH);
  const key = normalizeCode(str(a.key, 16) ? a.key : "", SECRET_LENGTH);
  if (!code || !key || !int(a.expiresAt, 0, 8.64e15)) return null;
  if (!str(a.title, 64) || !str(a.host, 40) || !str(a.avatar, 16)) return null;
  if (!int(a.players, 0, 99) || !int(a.max, 1, 99) || !int(a.rounds, 1, 99) || !int(a.round, 0, 99)) return null;
  if (typeof a.teams !== "boolean" || typeof a.bombs !== "boolean" || !PHASES.has(a.phase as string)) return null;
  const host = clean(a.host, 20);
  if (!host) return null;
  return {
    code,
    key,
    expiresAt: a.expiresAt,
    title: clean(a.title, 28),
    host,
    avatar: clean(a.avatar, 8),
    players: Math.min(a.players, a.max),
    max: a.max,
    teams: a.teams,
    rounds: a.rounds,
    round: a.round,
    phase: a.phase as RoomAd["phase"],
    bombs: a.bombs,
  };
}

/**
 * Wire format: one announcement, a withdrawal, or a browser asking who's
 * there (hosts answer right away instead of on their next periodic announce).
 */
type DirectoryMsg = { v: 1; ad: RoomAd } | { v: 1; gone: string } | { v: 1; ask: 1 };

export interface RoomDirectory {
  /** Start (or update) announcing a room; null stops announcing and withdraws it. */
  publish(ad: RoomAd | null): void;
  /** Live list of rooms heard recently, newest first. */
  subscribe(fn: (rooms: RoomListing[]) => void): () => void;
  close(): void;
}

/**
 * Announce/expire logic shared by every medium. Subclasses only move strings.
 */
export abstract class DirectoryBase implements RoomDirectory {
  private ad: RoomAd | null = null;
  private readonly rooms = new Map<string, RoomListing>();
  private readonly subs = new Set<(rooms: RoomListing[]) => void>();
  private readonly timer: ReturnType<typeof setInterval>;
  protected closed = false;

  constructor(private readonly now: () => number = Date.now) {
    this.timer = setInterval(() => this.tick(), 1000);
  }

  protected abstract transmit(data: string): void;

  /** Subclasses call this with whatever arrived. */
  protected receive(data: unknown): void {
    if (this.closed || typeof data !== "string" || data.length > 4096) return;
    let m: Partial<DirectoryMsg> & Record<string, unknown>;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!m || m.v !== 1) return;
    if (m.ask === 1) {
      // Someone just opened the room list: answer now (at most once a second).
      if (this.ad && this.now() - this.lastAnnounce > 1000) this.announce();
      return;
    }
    if (typeof m.gone === "string") {
      const code = normalizeCode(m.gone, ROOM_CODE_LENGTH);
      if (code && this.rooms.delete(code)) this.emit();
      return;
    }
    const ad = parseRoomAd(m.ad);
    if (!ad || ad.expiresAt < this.now()) return;
    if (!this.rooms.has(ad.code) && this.rooms.size >= MAX_LISTINGS) return;
    this.rooms.set(ad.code, { ...ad, seenAt: this.now() });
    this.emit();
  }

  publish(ad: RoomAd | null): void {
    if (this.closed) return;
    const prev = this.ad;
    if (!ad) {
      this.ad = null;
      if (prev) this.transmit(JSON.stringify({ v: 1, gone: prev.code }));
      return;
    }
    const changed = !prev || JSON.stringify(prev) !== JSON.stringify(ad);
    this.ad = { ...ad };
    if (changed) this.announce();
  }

  private lastAnnounce = 0;

  private announce(): void {
    if (!this.ad) return;
    this.lastAnnounce = this.now();
    this.transmit(JSON.stringify({ v: 1, ad: this.ad }));
  }

  subscribe(fn: (rooms: RoomListing[]) => void): () => void {
    this.subs.add(fn);
    fn(this.list());
    // A new listener: ask hosts to announce now rather than wait for their next beat.
    this.ask();
    return () => this.subs.delete(fn);
  }

  private lastAsk = -Infinity;

  private ask(): void {
    if (this.closed || this.now() - this.lastAsk < 1000) return;
    this.lastAsk = this.now();
    this.transmit(JSON.stringify({ v: 1, ask: 1 }));
  }

  /**
   * Subclasses call this when a link to the medium (re)opens: anything sent
   * before it was lost, so re-announce our room and ask who else is there.
   */
  protected connected(): void {
    if (this.closed) return;
    if (this.ad) this.announce();
    if (this.subs.size > 0) {
      this.lastAsk = -Infinity;
      this.ask();
    }
  }

  list(): RoomListing[] {
    return [...this.rooms.values()].sort((a, b) => b.seenAt - a.seenAt);
  }

  private emit(): void {
    const l = this.list();
    for (const s of this.subs) s(l);
  }

  private tick(): void {
    const now = this.now();
    if (this.ad && now - this.lastAnnounce >= DIRECTORY_ANNOUNCE_MS) this.announce();
    let dropped = false;
    for (const [code, r] of this.rooms) {
      if (now - r.seenAt > DIRECTORY_TTL_MS || r.expiresAt < now) {
        this.rooms.delete(code);
        dropped = true;
      }
    }
    if (dropped) this.emit();
  }

  close(): void {
    if (this.closed) return;
    this.publish(null);
    this.closed = true;
    clearInterval(this.timer);
    this.subs.clear();
  }
}

/** Same-device directory over BroadcastChannel (rooms opened with "same device only"). */
export class BroadcastDirectory extends DirectoryBase {
  private readonly bc: BroadcastChannel;

  constructor() {
    super();
    this.bc = new BroadcastChannel("tk-directory-v1");
    this.bc.onmessage = (e: MessageEvent) => this.receive(e.data);
  }

  protected transmit(data: string): void {
    this.bc.postMessage(data);
  }

  override close(): void {
    super.close();
    this.bc.close();
  }
}

/** In-memory directory hub for tests. */
export class MemoryDirectoryHub {
  private readonly members = new Set<MemoryDirectory>();
  join(d: MemoryDirectory): void {
    this.members.add(d);
  }
  leave(d: MemoryDirectory): void {
    this.members.delete(d);
  }
  send(from: MemoryDirectory, data: string): void {
    if (!this.members.has(from)) return; // disconnected
    for (const m of this.members) if (m !== from) m.deliver(data);
  }
}

export class MemoryDirectory extends DirectoryBase {
  constructor(private readonly hub: MemoryDirectoryHub, now?: () => number) {
    super(now);
    hub.join(this);
  }
  protected transmit(data: string): void {
    this.hub.send(this, data);
  }
  deliver(data: string): void {
    this.receive(data);
  }
  override close(): void {
    super.close();
    this.hub.leave(this);
  }
}


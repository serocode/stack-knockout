import { useEffect, useState } from "react";
import { BroadcastDirectory, type RoomAd, type RoomDirectory, type RoomListing } from "@tk/net";
import { MAX_PLAYERS, type Coordinator } from "@tk/coordinator";
import { fromWire } from "../cosmetics/catalog";
import { loadSettings } from "./settings";
import type { Session } from "./session";

/**
 * Public "waiting rooms": rooms whose host ticked "list publicly". Online
 * rooms are announced over Nostr relays, same-device rooms over a
 * BroadcastChannel. One shared connection per medium, ref-counted.
 */
export type DirectoryMode = "online" | "local";

interface Shared {
  dir: Promise<RoomDirectory>;
  refs: number;
}
const shared = new Map<DirectoryMode, Shared>();

function open(mode: DirectoryMode): Promise<RoomDirectory> {
  if (mode === "local") return Promise.resolve(new BroadcastDirectory());
  return import("@tk/net/nostr-directory").then(({ NostrDirectory }) => {
    const relays = loadSettings().relayUrls.split(/\s+/).filter(Boolean);
    return relays.length ? new NostrDirectory(relays) : new NostrDirectory();
  });
}

function acquire(mode: DirectoryMode): { dir: Promise<RoomDirectory>; release: () => void } {
  let s = shared.get(mode);
  if (!s) shared.set(mode, (s = { dir: open(mode), refs: 0 }));
  s.refs++;
  const mine = s;
  let released = false;
  return {
    dir: mine.dir,
    release: () => {
      if (released) return;
      released = true;
      if (--mine.refs > 0) return;
      // Linger briefly so hopping between the browser and a room doesn't reconnect.
      window.setTimeout(() => {
        if (mine.refs > 0 || shared.get(mode) !== mine) return;
        shared.delete(mode);
        void mine.dir.then((d) => d.close()).catch(() => undefined);
      }, 4000);
    },
  };
}

export type Listing = RoomListing & { mode: DirectoryMode };

/** Rooms heard on both media, freshest first. */
export function useRoomListings(): { rooms: Listing[]; error: string | null } {
  const [rooms, setRooms] = useState<{ online: RoomListing[]; local: RoomListing[] }>({ online: [], local: [] });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const subs: (() => void)[] = [];
    const releases: (() => void)[] = [];
    let alive = true;
    for (const mode of ["online", "local"] as const) {
      const h = acquire(mode);
      releases.push(h.release);
      h.dir
        .then((d) => {
          if (alive) subs.push(d.subscribe((l) => setRooms((r) => ({ ...r, [mode]: l }))));
        })
        .catch((e: unknown) => mode === "online" && setError(e instanceof Error ? e.message : String(e)));
    }
    return () => {
      alive = false;
      subs.forEach((u) => u());
      releases.forEach((r) => r());
    };
  }, []);
  const all: Listing[] = [...rooms.online.map((r) => ({ ...r, mode: "online" as const })), ...rooms.local.map((r) => ({ ...r, mode: "local" as const }))];
  all.sort((a, b) => (a.phase === "lobby" ? 0 : 1) - (b.phase === "lobby" ? 0 : 1) || b.seenAt - a.seenAt);
  return { rooms: all, error };
}

/**
 * While we are the host of a listed room, keep it announced. Any member can
 * become host after a migration, so every member runs this and only the
 * current host actually publishes.
 */
export function useAnnounceRoom(coord: Coordinator | null, session: Session | null): void {
  const mode: DirectoryMode | null = session?.mode === "online" ? "online" : session?.mode === "local" ? "local" : null;
  // The caller re-renders on every coordinator change (useCoordinator), so the ad stays current.
  const v = coord?.view();
  const st = v?.state;
  const me = st?.roster.find((r) => r.playerId === coord?.playerId);
  const want = !!(mode && session && v?.isHost && st && st.options.listed && !st.closed && me);
  const ad: RoomAd | null =
    want && st && me && session
      ? {
          code: session.creds.roomCode,
          key: session.creds.secret,
          expiresAt: session.creds.expiresAt,
          title: st.options.title,
          host: me.name,
          avatar: fromWire(me.cosmetics).avatar,
          players: st.roster.length,
          max: MAX_PLAYERS,
          teams: st.options.teams,
          rounds: st.options.rounds,
          round: st.match && st.phase !== "lobby" ? st.match.round : 0,
          phase: st.phase,
          bombs: st.options.bombs !== "off",
        }
      : null;
  const key = ad ? JSON.stringify(ad) : null;

  // Hold the medium open for as long as we are in a room of that kind.
  const [dir, setDir] = useState<RoomDirectory | null>(null);
  useEffect(() => {
    if (!mode) return;
    const h = acquire(mode);
    let alive = true;
    void h.dir.then((d) => alive && setDir(d)).catch(() => undefined);
    return () => {
      alive = false;
      void h.dir.then((d) => d.publish(null)).catch(() => undefined);
      h.release();
    };
  }, [mode]);

  useEffect(() => {
    dir?.publish(key ? (JSON.parse(key) as RoomAd) : null);
  }, [dir, key]);
}

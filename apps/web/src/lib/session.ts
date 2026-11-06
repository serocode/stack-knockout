import { Coordinator } from "@tk/coordinator";
import { BroadcastTransport, Mesh, newPlayerId, realClock, signalingRoomId, type RoomCredentials, type Transport } from "@tk/net";
import { CpuOpponents, type CpuLevel } from "./cpu";
import { playerIdFor } from "./identity";
import { loadSettings } from "./settings";
import { getPrefs, subscribePrefs } from "./prefs";
import { tierForScore, toWire } from "../cosmetics/catalog";
import { getProfile, subscribeProfile } from "../progress/profile";

export type NetMode = "online" | "local" | "cpu";

export interface Session {
  creds: RoomCredentials;
  mode: NetMode;
  coord: Coordinator;
  mesh: Mesh;
  /** Computer opponents ("cpu" mode only). */
  cpu?: CpuOpponents;
  close: () => void;
}

const APP_ID = "stack-knockout-v1";

/**
 * Wires transport -> mesh -> coordinator. "online" uses WebRTC with Trystero's
 * Nostr signaling; "local" uses BroadcastChannel between tabs on one device.
 */
export async function openSession(opts: { creds: RoomCredentials; mode: NetMode; name: string; create: boolean; cpu?: { count: number; level: CpuLevel } }): Promise<Session> {
  if (opts.mode === "cpu") return openCpuSession({ ...opts, cpu: opts.cpu ?? { count: 1, level: "medium" } });
  const { playerId, release } = playerIdFor(opts.creds.roomCode, opts.mode === "local");
  let transport: Transport;
  if (opts.mode === "local") {
    transport = new BroadcastTransport(opts.creds.roomCode);
  } else {
    const { TrysteroTransport, webrtcSignalingAvailable } = await import("@tk/net/trystero");
    if (!webrtcSignalingAvailable()) throw new Error("no-webrtc");
    const s = loadSettings();
    const turn = turnConfig(s);
    transport = new TrysteroTransport({
      appId: APP_ID,
      roomId: signalingRoomId(opts.creds.roomCode),
      password: opts.creds.secret,
      ...(turn ? { turn: [turn] } : {}),
      ...(s.relayUrls.trim() ? { relayUrls: s.relayUrls.split(/\s+/).filter(Boolean) } : {}),
    });
  }
  const mesh = new Mesh({ transport, clock: realClock, roomId: opts.creds.roomCode, secret: opts.creds.secret, playerId });

  // Remember that this identity created the room, so a reload (or the dev
  // server's auto-reload) can recreate it if nobody else is hosting it.
  const store = opts.mode === "local" ? sessionStorage : localStorage;
  const creatorKey = `tk.creator.${opts.creds.roomCode}`;
  try {
    if (opts.create) store.setItem(creatorKey, playerId);
  } catch {
    /* storage unavailable */
  }
  let isCreator = opts.create;
  try {
    isCreator ||= store.getItem(creatorKey) === playerId;
  } catch {
    /* storage unavailable */
  }
  const coord = new Coordinator({
    mesh,
    clock: realClock,
    name: opts.name,
    create: opts.create,
    cosmetics: toWire(getPrefs().cosmetics, tierForScore(getProfile().careerScore).id),
    // Relays can take several seconds to introduce peers; give an existing host time to answer.
    ...(isCreator && !opts.create ? { hostIfAloneAfterMs: opts.mode === "local" ? 4000 : 9000 } : {}),
  });

  // Closing/reloading the tab tears down the peer connections so others notice
  // immediately (no heartbeat timeout), but we do NOT send "leaving": the
  // identity stays reserved so a reload or reopened link resumes the same board.
  // An explicit Leave button sends "leaving" (forfeit + seat released).
  const onHide = () => void mesh.close();
  window.addEventListener("pagehide", onHide);

  const unsubPrefs = shareCosmetics(coord);
  return {
    creds: opts.creds,
    mode: opts.mode,
    coord,
    mesh,
    close: () => {
      window.removeEventListener("pagehide", onHide);
      unsubPrefs();
      coord.leave();
      release();
    },
  };
}

/**
 * TURN relay for networks that block direct peer-to-peer (school/office
 * Wi-Fi). Settings win; otherwise use the server baked in at build time via
 * VITE_TURN_URLS / VITE_TURN_USER / VITE_TURN_CREDENTIAL, so players don't
 * each have to configure it. URLs are whitespace-separated; list a
 * `turns:...:443?transport=tcp` entry, since strict networks often allow only
 * TLS on port 443.
 */
function turnConfig(s: ReturnType<typeof loadSettings>): { urls: string[]; username?: string; credential?: string } | null {
  const env = import.meta.env;
  const fromSettings = s.turnUrl.trim() !== "";
  const urls = (fromSettings ? s.turnUrl : String(env.VITE_TURN_URLS ?? "")).split(/\s+/).filter(Boolean);
  if (urls.length === 0) return null;
  const username = fromSettings ? s.turnUser : String(env.VITE_TURN_USER ?? "");
  const credential = fromSettings ? s.turnCredential : String(env.VITE_TURN_CREDENTIAL ?? "");
  return { urls, username: username || undefined, credential: credential || undefined };
}

/**
 * Practice against the computer: the player hosts a room on an in-memory
 * network in this tab and bot coordinators join it. No signaling, no peers.
 */
function openCpuSession(opts: { creds: RoomCredentials; name: string; cpu: { count: number; level: CpuLevel } }): Session {
  const cpu = new CpuOpponents(opts.creds.roomCode, opts.creds.secret, opts.cpu.level, opts.cpu.count);
  const playerId = newPlayerId();
  const mesh = new Mesh({ transport: cpu.net.createTransport(`me-${playerId}`), clock: realClock, roomId: opts.creds.roomCode, secret: opts.creds.secret, playerId });
  const coord = new Coordinator({
    mesh,
    clock: realClock,
    name: opts.name,
    create: true,
    cosmetics: toWire(getPrefs().cosmetics, tierForScore(getProfile().careerScore).id),
  });
  const unsubPrefs = shareCosmetics(coord);
  return {
    creds: opts.creds,
    mode: "cpu",
    coord,
    mesh,
    cpu,
    close: () => {
      unsubPrefs();
      cpu.close();
      void coord.destroy();
    },
  };
}

/** Share cosmetic changes with the room as they happen (visual only). Returns an unsubscribe. */
function shareCosmetics(coord: Coordinator): () => void {
  let lastWire = JSON.stringify(toWire(getPrefs().cosmetics, tierForScore(getProfile().careerScore).id));
  const pushLook = () => {
    const wire = toWire(getPrefs().cosmetics, tierForScore(getProfile().careerScore).id);
    const j = JSON.stringify(wire);
    if (j === lastWire) return;
    lastWire = j;
    coord.setCosmetics(wire);
  };
  const unsubLook = subscribePrefs(pushLook);
  const unsubTier = subscribeProfile(pushLook);
  return () => {
    unsubLook();
    unsubTier();
  };
}

import { Coordinator } from "@tk/coordinator";
import { BroadcastTransport, Mesh, realClock, signalingRoomId, type RoomCredentials, type Transport } from "@tk/net";
import { playerIdFor } from "./identity";
import { loadSettings } from "./settings";
import { getPrefs, subscribePrefs } from "./prefs";
import { tierForScore, toWire } from "../cosmetics/catalog";
import { getProfile, subscribeProfile } from "../progress/profile";

export type NetMode = "online" | "local";

export interface Session {
  creds: RoomCredentials;
  mode: NetMode;
  coord: Coordinator;
  mesh: Mesh;
  close: () => void;
}

const APP_ID = "tetris-knockout-v1";

/**
 * Wires transport -> mesh -> coordinator. "online" uses WebRTC with Trystero's
 * Nostr signaling; "local" uses BroadcastChannel between tabs on one device.
 */
export async function openSession(opts: { creds: RoomCredentials; mode: NetMode; name: string; create: boolean }): Promise<Session> {
  const { playerId, release } = playerIdFor(opts.creds.roomCode, opts.mode === "local");
  let transport: Transport;
  if (opts.mode === "local") {
    transport = new BroadcastTransport(opts.creds.roomCode);
  } else {
    const { TrysteroTransport, webrtcSignalingAvailable } = await import("@tk/net/trystero");
    if (!webrtcSignalingAvailable()) throw new Error("no-webrtc");
    const s = loadSettings();
    transport = new TrysteroTransport({
      appId: APP_ID,
      roomId: signalingRoomId(opts.creds.roomCode),
      password: opts.creds.secret,
      ...(s.turnUrl ? { turn: [{ urls: s.turnUrl, username: s.turnUser || undefined, credential: s.turnCredential || undefined }] } : {}),
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

  // Share cosmetic changes with the room as they happen (visual only).
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
  const unsubPrefs = () => {
    unsubLook();
    unsubTier();
  };
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

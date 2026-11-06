import { useEffect, useMemo, useState } from "react";
import { normalizeCode, ROOM_CODE_LENGTH, SECRET_LENGTH, type RoomCredentials } from "@tk/net";
import { audio } from "./audio/audio";
import { savedName } from "./lib/identity";
import { isTouchDevice } from "./lib/device";
import { usePrefs } from "./lib/prefs";
import { Customize } from "./screens/Customize";
import { ProfileScreen } from "./screens/Profile";
import { Backdrop } from "./ui/Backdrop";
import { UnlockToasts } from "./ui/Toasts";
import { Lab } from "./lab/Lab";
import { Room } from "./screens/Room";
import { Create, Join, Menu, SettingsScreen, Solo, VsComputer } from "./screens/Menus";
import { MAX_CPU, isCpuLevel, type CpuLevel } from "./lib/cpu";
import type { NetMode } from "./lib/session";

/** Hash routing keeps invite secrets in the fragment and needs no server rewrites. */
export function App({ hash }: { hash: string }) {
  const go = (h: string) => {
    location.hash = h;
  };
  const prefs = usePrefs();

  // Touch devices get on-screen controls (CSS keys off this attribute).
  useEffect(() => {
    document.documentElement.dataset.touch = String(isTouchDevice());
  }, []);

  // Theme (local only) on the root element.
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
    document.documentElement.dataset.reduceMotion = String(prefs.reduceMotion);
  }, [prefs.theme, prefs.reduceMotion]);

  // Audio settings, and unlocking WebAudio on the first user gesture (autoplay rules).
  useEffect(() => {
    audio.configure({ pack: prefs.soundPack, track: prefs.music, master: prefs.masterVolume, music: prefs.musicVolume, sfx: prefs.sfxVolume });
  }, [prefs.soundPack, prefs.music, prefs.masterVolume, prefs.musicVolume, prefs.sfxVolume]);
  useEffect(() => {
    const unlock = () => audio.unlock();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
  const path = hash.split("?")[0];

  const room = useMemo(() => {
    if (path !== "#/room") return null;
    const p = new URLSearchParams(hash.split("?")[1] ?? "");
    const r = normalizeCode(p.get("r") ?? "", ROOM_CODE_LENGTH);
    const k = normalizeCode(p.get("k") ?? "", SECRET_LENGTH);
    if (!r || !k) return null;
    const creds: RoomCredentials = { roomCode: r, secret: k, expiresAt: Number(p.get("e") ?? 0) };
    const m = p.get("m");
    const mode: NetMode = m === "local" || m === "cpu" ? m : "online";
    // Computer opponents live only in this tab, so a cpu room is always created fresh.
    const cpu = mode === "cpu" ? { count: Math.min(MAX_CPU, Math.max(1, Number(p.get("bots")) || 1)), level: isCpuLevel(p.get("lvl")) ? (p.get("lvl") as CpuLevel) : ("medium" as const) } : undefined;
    return { creds, mode, create: mode === "cpu" || p.get("new") === "1", cpu };
  }, [hash, path]);

  // After creating, drop the "new" flag so a reload rejoins instead of re-creating.
  useEffect(() => {
    if (room?.create) {
      const p = new URLSearchParams(hash.split("?")[1] ?? "");
      p.delete("new");
      history.replaceState(null, "", `#/room?${p.toString()}`);
    }
  }, [room, hash]);

  if (path === "#/room") {
    if (!room) return <Menu go={go} />;
    const name = savedName() || "Player";
    if (!savedName() && room.mode !== "cpu") {
      go(`#/join?${new URLSearchParams({ r: room.creds.roomCode, k: room.creds.secret, e: String(room.creds.expiresAt) })}`);
      return null;
    }
    return <Room key={`${room.creds.roomCode}-${room.mode}`} creds={room.creds} mode={room.mode} name={name} create={room.create} cpu={room.cpu} go={go} />;
  }
  switch (path) {
    case "#/create":
      return <Create go={go} />;
    case "#/join":
      return <Join go={go} hash={hash} />;
    case "#/cpu":
      return <VsComputer go={go} />;
    case "#/solo":
      return <Solo go={go} />;
    case "#/lab":
      return <Lab go={go} />;
    case "#/customize":
      return <Customize onClose={() => go("#/")} />;
    case "#/settings":
      return <SettingsScreen go={go} />;
    case "#/profile":
      return <ProfileScreen go={go} />;
    default:
      return <Menu go={go} />;
  }
}

/** Shell: animated backdrop on menu-type screens, unlock toasts everywhere. */
export function Shell() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const path = hash.split("?")[0] ?? "#/";
  const calm = ["#/", "", "#/create", "#/join", "#/cpu", "#/settings", "#/profile", "#/customize"].includes(path);
  return (
    <>
      {calm && <Backdrop />}
      <div className="screen" key={path}>
        <App hash={hash} />
      </div>
      <UnlockToasts go={(h) => (location.hash = h)} />
    </>
  );
}

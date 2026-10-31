import { newPlayerId } from "@tk/net";

/**
 * Stable per-room player identity.
 *
 * - The identity lives in localStorage, so closing the browser and reopening
 *   the invite restores it (spec §7).
 * - Each tab also remembers which identity IT uses (sessionStorage survives a
 *   reload of that tab), so reloading always resumes the same player.
 * - A heartbeat lock tagged with a per-tab id stops a SECOND tab of the same
 *   browser from claiming an identity another live tab is using; that tab gets
 *   its own identity. A tab always recognises its own lock, so a reload is not
 *   mistaken for another tab. (Before this, a reload within a few seconds came
 *   back as a brand-new player: no seat, no board, no creator status.)
 * - Local (same-device) rooms keep everything in sessionStorage, so every tab
 *   is a distinct player.
 */
const LOCK_MS = 4000;
const PID_RE = /^[0-9a-f]{32}$/;

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Per-tab id that survives reloads of this tab but is unique per tab. */
function tabId(): string {
  let id = safe(() => sessionStorage.getItem("tk.tab"), null);
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    safe(() => sessionStorage.setItem("tk.tab", id!), undefined);
  }
  return id;
}

type Lock = { tab: string; at: number };

function lockHeldByOtherTab(pid: string, me: string): boolean {
  const held = safe(() => JSON.parse(localStorage.getItem(`tk.lock.${pid}`) ?? "null") as Lock | null, null);
  return !!held && held.tab !== me && Date.now() - held.at < LOCK_MS;
}

function pruneStaleLocks(): void {
  safe(() => {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith("tk.lock.")) continue;
      const l = JSON.parse(localStorage.getItem(k) ?? "null") as Lock | null;
      if (!l || Date.now() - l.at > 60_000) localStorage.removeItem(k);
    }
  }, undefined);
}

export function playerIdFor(roomCode: string, local: boolean): { playerId: string; release: () => void } {
  if (local) {
    const key = `tk.pid.${roomCode}`;
    let pid = safe(() => sessionStorage.getItem(key), null);
    if (!pid || !PID_RE.test(pid)) {
      pid = newPlayerId();
      safe(() => sessionStorage.setItem(key, pid!), undefined);
    }
    return { playerId: pid, release: () => undefined };
  }

  pruneStaleLocks();
  const me = tabId();
  const tabKey = `tk.tabpid.${roomCode}`;
  const sharedKey = `tk.pid.${roomCode}`;

  // 1. This tab's own identity from before a reload.
  let pid = safe(() => sessionStorage.getItem(tabKey), null);
  if (pid && (!PID_RE.test(pid) || lockHeldByOtherTab(pid, me))) pid = null;
  // 2. The browser's identity for this room (e.g. after closing and reopening).
  if (!pid) {
    const shared = safe(() => localStorage.getItem(sharedKey), null);
    if (shared && PID_RE.test(shared) && !lockHeldByOtherTab(shared, me)) pid = shared;
  }
  // 3. Otherwise a new identity; remember it as the browser's if there was none.
  if (!pid) {
    pid = newPlayerId();
    if (!safe(() => localStorage.getItem(sharedKey), null)) safe(() => localStorage.setItem(sharedKey, pid!), undefined);
  }
  const finalPid = pid;
  safe(() => sessionStorage.setItem(tabKey, finalPid), undefined);

  const lk = `tk.lock.${finalPid}`;
  const touch = () => safe(() => localStorage.setItem(lk, JSON.stringify({ tab: me, at: Date.now() } satisfies Lock)), undefined);
  touch();
  const timer = window.setInterval(touch, 1000);
  return {
    playerId: finalPid,
    release: () => {
      window.clearInterval(timer);
      safe(() => localStorage.removeItem(lk), undefined);
    },
  };
}

export function savedName(): string {
  return safe(() => localStorage.getItem("tk.name"), null) ?? "";
}

export function saveName(name: string): void {
  safe(() => localStorage.setItem("tk.name", name), undefined);
}

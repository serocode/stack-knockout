import { useEffect, useMemo, useRef, useState } from "react";
import { Logo, LogoMark } from "../ui/Logo";
import { tierForScore } from "../cosmetics/catalog";
import { TierBadge, TierProgress } from "./Profile";
import { PlayerSim, type Placement } from "@tk/engine";
import { isTouchDevice } from "../lib/device";
import { setPrefs, usePrefs, type TouchMode } from "../lib/prefs";
import { Volume } from "./Customize";
import { recordGame, useProfile } from "../progress/profile";
import { CODE_ALPHABET, ROOM_CODE_LENGTH, SECRET_LENGTH, createRoomCredentials, normalizeCode, parseInvite } from "@tk/net";
import { saveName, savedName } from "../lib/identity";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "../lib/settings";
import { Playfield } from "./Playfield";

type Go = (h: string) => void;

export function Menu({ go }: { go: Go }) {
  const prefs = usePrefs();
  const profile = useProfile();
  const name = savedName();
  const tier = tierForScore(profile.careerScore);
  const tiles: { icon: string; label: string; hint: string; to: string }[] = [
    { icon: "▶", label: "Practice", hint: "Solo, no pressure", to: "#/solo" },
    { icon: "🎨", label: "Customize", hint: "Skins, frames, effects", to: "#/customize" },
    { icon: "🏆", label: "Trophies", hint: `${Object.keys(profile.achievements).length} achievements`, to: "#/profile" },
    { icon: "⚙", label: "Settings", hint: "Controls, audio, access", to: "#/settings" },
  ];
  return (
    <div className="page menu-page">
      <div className="hero">
        <Logo />
        <p className="tagline">Six friends. One board each. Last stack standing wins.</p>
        <button className="profile-card" onClick={() => go("#/profile")}>
          <span className="avatar lg">{prefs.cosmetics.avatar}</span>
          <span className="profile-card-body">
            <span className="profile-card-top">
              <b>{name || "New player"}</b>
              <TierBadge tier={tier} />
            </span>
            <span className="muted small">{profile.careerScore.toLocaleString()} career points</span>
            <TierProgress score={profile.careerScore} />
          </span>
        </button>
        <div className="primary-actions">
          <button className="big-btn" onClick={() => go("#/create")}>
            <span className="big-btn-title">Create room</span>
            <span className="big-btn-sub">Invite up to 5 friends</span>
          </button>
          <button className="big-btn alt" onClick={() => go("#/join")}>
            <span className="big-btn-title">Join room</span>
            <span className="big-btn-sub">Use a link or code</span>
          </button>
        </div>
        <div className="menu-tiles">
          {tiles.map((t) => (
            <button key={t.to} className="menu-tile" onClick={() => go(t.to)}>
              <span className="menu-tile-icon">{t.icon}</span>
              <span className="menu-tile-label">{t.label}</span>
              <span className="menu-tile-hint">{t.hint}</span>
            </button>
          ))}
        </div>
        <button className="link-btn" onClick={() => go("#/lab")}>Open the migration lab →</button>
      </div>
    </div>
  );
}

function NameField({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <>
      <label>Your name</label>
      <input value={value} maxLength={20} placeholder="Name" onChange={(e) => onChange(e.target.value)} autoFocus />
    </>
  );
}

export function Create({ go }: { go: Go }) {
  const [name, setName] = useState(savedName());
  const [local, setLocal] = useState(false);
  return (
    <div className="page">
      <div className="panel narrow">
        <h2>Create a room</h2>
        <NameField value={name} onChange={setName} />
        <label className="check">
          <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} />
          Same device only (tabs on this browser — for testing without internet)
        </label>
        <div className="row">
          <button
            disabled={!name.trim()}
            onClick={() => {
              saveName(name.trim());
              const c = createRoomCredentials();
              go(`#/room?${new URLSearchParams({ r: c.roomCode, k: c.secret, e: String(c.expiresAt), m: local ? "local" : "online", new: "1" })}`);
            }}
          >
            Create
          </button>
          <button className="ghost" onClick={() => go("#/")}>Back</button>
        </div>
      </div>
    </div>
  );
}

export function Join({ go, hash }: { go: Go; hash: string }) {
  const invite = useMemo(() => parseInvite(hash), [hash]);
  const params = new URLSearchParams(hash.split("?")[1] ?? "");
  const local = params.get("m") === "local";
  const [name, setName] = useState(savedName());
  const [code, setCode] = useState(invite.ok ? invite.creds.roomCode : "");
  const [key, setKey] = useState(invite.ok ? invite.creds.secret : "");
  const nCode = normalizeCode(code, ROOM_CODE_LENGTH);
  const nKey = normalizeCode(key, SECRET_LENGTH);
  const expired = !invite.ok && invite.error === "expired";
  return (
    <div className="page">
      <div className="panel narrow">
        <h2>Join a room</h2>
        {expired && <p className="warn">This invite link has expired. Ask the host for a new one.</p>}
        <NameField value={name} onChange={setName} />
        {!invite.ok && (
          <>
            <label>Room code</label>
            <input className="mono" value={code} maxLength={8} placeholder="ABC123" onChange={(e) => setCode(e.target.value.toUpperCase())} />
            <label>Invite key</label>
            <input className="mono" value={key} maxLength={12} placeholder="XXXXX-XXXXX" onChange={(e) => setKey(e.target.value.toUpperCase())} />
            <p className="muted small">Letters and digits only ({CODE_ALPHABET.length}-character alphabet, no I/L/O/U/0/1).</p>
          </>
        )}
        {invite.ok && (
          <p className="muted">
            Room <b className="mono">{invite.creds.roomCode}</b>
          </p>
        )}
        <div className="row">
          <button
            disabled={!name.trim() || !nCode || !nKey}
            onClick={() => {
              saveName(name.trim());
              const exp = invite.ok ? invite.creds.expiresAt : Date.now() + 3600_000;
              go(`#/room?${new URLSearchParams({ r: nCode!, k: nKey!, e: String(exp), m: local ? "local" : "online" })}`);
            }}
          >
            Join
          </button>
          <button className="ghost" onClick={() => go("#/")}>Back</button>
        </div>
      </div>
    </div>
  );
}

export function Solo({ go }: { go: Go }) {
  const [sim, setSim] = useState(() => PlayerSim.create((Math.random() * 2 ** 32) >>> 0));
  const [gameId, setGameId] = useState(() => `solo-${Date.now().toString(36)}`);
  // A practice game counts when it ends (top out) or when you restart/leave with points on the board.
  const finish = () => {
    if (sim.s.score > 0 || sim.s.toppedOut) recordGame({ id: gameId, score: sim.s.score });
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => () => finishRef.current(), []);
  useEffect(() => {
    if (sim.s.toppedOut) finish();
  });
  const [, setTick] = useState(0);
  const [startedAt, setStartedAt] = useState(() => performance.now());
  const onLock = (p: Placement) => {
    const out = sim.applyPlacement(p, []);
    setTick((t) => t + 1);
    return out.ok ? out.result : null;
  };
  const secs = (performance.now() - startedAt) / 1000;
  const restart = () => {
    finish();
    setGameId(`solo-${Date.now().toString(36)}`);
    setSim(PlayerSim.create((Math.random() * 2 ** 32) >>> 0));
    setStartedAt(performance.now());
  };
  return (
    <div className="room">
      <header className="topbar">
        <button className="brand" onClick={() => go("#/")} aria-label="Main menu"><LogoMark size={30} /></button>
        <strong>Practice</strong>
        <div className="grow" />
        <button className="small ghost" onClick={restart}>Restart</button>
      </header>
      <div className="match solo">
        <div className="mine">
          <Playfield
            sim={sim}
            paused={false}
            gravityMs={Math.max(90, 1000 * Math.pow(0.9, secs / 15))}
            cellSize={Math.max(14, Math.min(32, Math.floor((window.innerHeight - 160 - (isTouchDevice() ? 150 : 0)) / 20), Math.floor((window.innerWidth - 130) / 10)))}
            incomingQueued={0}
            incomingLanding={0}
            onLock={onLock}
            overlay={sim.s.toppedOut ? "Top out" : null}
            boardId="solo"
          />
          {sim.s.toppedOut && <button onClick={restart}>Play again</button>}
        </div>
      </div>
    </div>
  );
}

export function SettingsScreen({ go }: { go: Go }) {
  const [s, setS] = useState<Settings>(loadSettings());
  const prefs = usePrefs();
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  const toggle = (label: string, value: boolean, onChange: (v: boolean) => void, hint?: string) => (
    <label className="check">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="muted small"> — {hint}</span>}
      </span>
    </label>
  );
  return (
    <div className="page">
      <div className="panel narrow settings">
        <h2>Settings</h2>
        <NameField value={savedName()} onChange={saveName} />

        <h3>Controls</h3>
        <label>DAS (ms) — delay before auto-shift</label>
        <input type="number" value={s.dasMs} min={0} max={500} onChange={(e) => set("dasMs", Number(e.target.value))} />
        <label>ARR (ms) — auto-repeat rate (0 = instant)</label>
        <input type="number" value={s.arrMs} min={0} max={200} onChange={(e) => set("arrMs", Number(e.target.value))} />
        <label>Touch controls</label>
        <div className="seg">
          {(["both", "gestures", "buttons"] as TouchMode[]).map((m) => (
            <button key={m} className={`small ${prefs.touchMode === m ? "on" : "ghost"}`} onClick={() => setPrefs({ touchMode: m })}>
              {m === "both" ? "Gestures + buttons" : m === "gestures" ? "Gestures only" : "Buttons only"}
            </button>
          ))}
        </div>
        <p className="muted small">Gestures: drag to move · tap left/right half to rotate · swipe down to drop · swipe up to hold · drag down slowly to soft drop.</p>
        {toggle("Vibration", prefs.haptics, (haptics) => setPrefs({ haptics }), "on supported phones")}

        <h3>Coaching</h3>
        {toggle("Suggestions & callouts", prefs.coaching, (coaching) => setPrefs({ coaching }), "show spots suggested by knocked-out players (press G to use one) and quick callouts")}

        <h3>Audio</h3>
        <Volume label="Master" value={prefs.masterVolume} onChange={(masterVolume) => setPrefs({ masterVolume })} />
        <Volume label="Music" value={prefs.musicVolume} onChange={(musicVolume) => setPrefs({ musicVolume })} />
        <Volume label="Effects" value={prefs.sfxVolume} onChange={(sfxVolume) => setPrefs({ sfxVolume })} />
        <p className="muted small">Sound packs and music tracks are under Customize → Sound.</p>

        <h3>Accessibility</h3>
        {toggle("Reduce motion", prefs.reduceMotion, (reduceMotion) => setPrefs({ reduceMotion }), "no screen shake, fewer particles, still backgrounds")}
        {toggle("Reduce flashing", prefs.reduceFlashing, (reduceFlashing) => setPrefs({ reduceFlashing }), "softer line-clear flashes, no lightning")}

        <h3>Network (optional)</h3>
        <p className="muted small">Only needed if friends can't connect (strict NAT / mobile carriers). Paste a managed TURN server's details.</p>
        <label>TURN URL</label>
        <input value={s.turnUrl} placeholder="turn:global.relay.metered.ca:80" onChange={(e) => set("turnUrl", e.target.value)} />
        <label>TURN username</label>
        <input value={s.turnUser} onChange={(e) => set("turnUser", e.target.value)} />
        <label>TURN credential</label>
        <input value={s.turnCredential} type="password" onChange={(e) => set("turnCredential", e.target.value)} />
        <label>Nostr relays (space-separated, blank = defaults)</label>
        <input value={s.relayUrls} placeholder="wss://relay.example" onChange={(e) => set("relayUrls", e.target.value)} />
        <p className="muted small">Keyboard: ←/→ move · ↓ soft drop · Space hard drop · ↑/X rotate CW · Z rotate CCW · C/Shift hold</p>
        <div className="row">
          <button
            onClick={() => {
              saveSettings(s);
              go("#/");
            }}
          >
            Save
          </button>
          <button className="ghost" onClick={() => setS({ ...DEFAULT_SETTINGS })}>Defaults</button>
          <button className="ghost" onClick={() => go("#/")}>Back</button>
        </div>
      </div>
    </div>
  );
}

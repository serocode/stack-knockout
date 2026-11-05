import { useEffect, useMemo, useRef, useState } from "react";
import { LogoMark } from "../ui/Logo";
import { PingBadge } from "../ui/Ping";
import type { Coordinator, CoordinatorEvent, MatchPlayer, RoomState } from "@tk/coordinator";
import { clearLines, pieceCells, spawnPos, writePiece, type Placement, type PiecePos, type PlayerSim, type Rotation } from "@tk/engine";
import { buildInviteUrl, formatSecret, type RoomCredentials } from "@tk/net";
import { audio } from "../audio/audio";
import { CALLOUTS, bestSuggestion, calloutOf, coachColor, dropAt, reachable } from "../coach/coach";
import { BLOCK_SKINS, EFFECTS, FRAMES, fromWire, labelOf, tierFromWire } from "../cosmetics/catalog";
import { recordGame } from "../progress/profile";
import { TierBadge } from "./Profile";
import { fx, tierFor } from "../fx/fx";
import { isTouchDevice } from "../lib/device";
import { getPrefs, usePrefs } from "../lib/prefs";
import { openSession, type NetMode, type Session } from "../lib/session";
import { useCoordinator } from "../lib/useCoordinator";
import { drawBoard, lookOf, sizeCanvas } from "../render/draw";
import { drawBlock } from "../render/skins";
import { Customize } from "./Customize";
import { Playfield, type PlayfieldHint } from "./Playfield";

interface Notice {
  id: number;
  text: string;
  tone: "info" | "warn" | "good";
}

/** A callout shown as a speech bubble over the sender's board. */
interface Bubble {
  id: number;
  from: string;
  text: string;
  x: number;
  y: number;
}

const boardEl = (pid: string) => document.querySelector<HTMLElement>(`[data-board="${CSS.escape(pid)}"]`);

export function Room({ creds, mode, name: nameProp, create, go }: { creds: RoomCredentials; mode: NetMode; name: string; create: boolean; go: (h: string) => void }) {
  // The name is fixed when the room opens: renaming in another tab must not tear down the session.
  const [name] = useState(nameProp);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [customizing, setCustomizing] = useState(false);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const nid = useRef(0);

  useEffect(() => {
    let s: Session | null = null;
    let cancelled = false;
    openSession({ creds, mode, name, create })
      .then((sess) => {
        if (cancelled) return sess.close();
        s = sess;
        setSession(sess);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      s?.close();
    };
  }, [creds, mode, name, create]);

  const coord = session?.coord ?? null;
  const v = useCoordinator(coord);
  const st = v?.state ?? null;
  const nameOf = (pid: string | null | undefined) => (pid && st?.roster.find((r) => r.playerId === pid)?.name) || "a player";
  const nameRef = useRef(nameOf);
  nameRef.current = nameOf;
  const stRef = useRef(st);
  stRef.current = st;

  // Notifications + sound/visual feedback for room-wide events.
  useEffect(() => {
    if (!coord) return;
    const push = (text: string, tone: Notice["tone"] = "info") => {
      const id = nid.current++;
      setNotices((n) => [...n.slice(-3), { id, text, tone }]);
      window.setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 4500);
    };
    const me = coord.playerId;
    const cosOf = (pid: string | null) => fromWire(stRef.current?.roster.find((r) => r.playerId === pid)?.cosmetics);
    const bubble = (from: string, text: string) => {
      const el = boardEl(from);
      if (!el) return push(`${cosOf(from).avatar} ${nameRef.current(from)}: ${text}`);
      const r = el.getBoundingClientRect();
      const id = nid.current++;
      setBubbles((b) => [...b.filter((x) => x.from !== from), { id, from, text, x: r.left + r.width / 2, y: r.top }]);
      window.setTimeout(() => setBubbles((b) => b.filter((x) => x.id !== id)), 3200);
    };
    return coord.on((e: CoordinatorEvent) => {
      const nm = nameRef.current;
      const P = getPrefs();
      fx.reduceMotion = P.reduceMotion;
      fx.reduceFlashing = P.reduceFlashing;
      switch (e.kind) {
        case "callout": {
          const c = calloutOf(e.code);
          if (!c || (e.from !== me && !P.coaching)) break;
          bubble(e.from, `${c.emoji} ${c.text(e.about ? (e.about === me ? "you" : nm(e.about)) : null)}`);
          if (e.from !== me) audio.play("click");
          break;
        }
        case "suggestion":
          if (e.suggestion.to === me && P.coaching) audio.play("click");
          break;
        case "suggestion-taken":
          if (e.coach === me) {
            push(`${nm(e.player)} used your suggestion 🙌`, "good");
            audio.play("join");
          } else if (e.player !== me) push(`${nm(e.player)} used ${nm(e.coach)}'s suggestion 💡`);
          break;
        case "migration-start":
          push(e.formerHost === me ? "Lost contact with most players — pausing" : `Host ${nm(e.formerHost)} lost — electing a new host…`, "warn");
          break;
        case "host-changed":
          push(e.hostId === me ? "You are now the host" : `${nm(e.hostId)} is now the host`, "good");
          break;
        case "match-abandoned":
          push("Couldn't recover the match — no result", "warn");
          break;
        case "resync":
          push("Board resynced with host", "warn");
          console.warn("[tk] resync:", e.reason);
          break;
        case "effect": {
          const f = e.effect;
          switch (f.kind) {
            case "ko": {
              push(f.by ? `${nm(f.by)} knocked out ${nm(f.victim)}` : `${nm(f.victim)} is out (#${f.placement})`, f.victim === me ? "warn" : "info");
              const el = boardEl(f.victim);
              if (el) fx.burst(rectOf(el), cosOf(f.by ?? f.victim).effect, 4, cosOf(f.victim).palette);
              audio.play(f.victim === me ? "lose" : "ko");
              break;
            }
            case "attack": {
              const from = boardEl(f.from);
              const to = boardEl(f.to);
              if (f.from === me) audio.play("attack");
              if (from && to)
                fx.projectile(from, to, cosOf(f.from).effect, f.lines, () => {
                  if (f.to === me) {
                    audio.play("garbageWarn");
                    fx.shake(to, 0.2);
                  } else fx.shake(to, 0.15);
                });
              break;
            }
            case "cancel":
              if (f.playerId === me) audio.play("cancel");
              break;
            case "lock":
              if (f.playerId !== me && f.result.lines > 0) {
                const el = boardEl(f.playerId);
                const tier = tierFor(f.result);
                if (el && tier) fx.burst(rectOf(el), cosOf(f.playerId).effect, Math.min(2, tier) as 1 | 2, cosOf(f.playerId).palette);
              }
              break;
            case "match-start":
              break;
            case "match-end":
              if (f.result.winner === me) audio.play("win");
              break;
            case "presence":
              push(`${nm(f.playerId)} ${f.connected ? "reconnected" : "disconnected"}`, f.connected ? "good" : "warn");
              break;
            case "joined":
              push(`${nm(f.playerId)} joined`, "good");
              if (f.playerId !== me) audio.play("join");
              break;
            case "left":
              push(`${nm(f.playerId)} ${f.reason === "timeout" ? "timed out" : "left"}`);
              break;
          }
          break;
        }
      }
    });
  }, [coord]);

  if (error === "no-webrtc")
    return (
      <Panel title="This browser can't play online">
        <p className="muted">It doesn't support WebRTC peer-to-peer connections. Try a current version of Chrome, Safari, Firefox or Edge.</p>
        <button onClick={() => go("#/")}>Back</button>
      </Panel>
    );
  if (error) return <Panel title="Couldn't open the room"><p className="muted">{error}</p><button onClick={() => go("#/")}>Back</button></Panel>;
  if (!session || !v || !coord) return <Panel title="Connecting…"><p className="muted">Starting {mode === "online" ? "WebRTC signaling" : "same-device channel"}…</p></Panel>;

  if (v.mode === "rejected")
    return (
      <Panel title="Couldn't join">
        <p className="muted">{v.rejectedReason === "full" ? "This room already has 6 players." : v.rejectedReason === "closed" ? "The host closed this room." : `Rejected: ${v.rejectedReason}`}</p>
        <button onClick={() => go("#/")}>Back to menu</button>
      </Panel>
    );

  if (v.mode === "joining" || !st) {
    // Public relays can take 10+ s to introduce peers; don't cry wolf too early.
    const long = v.joinWaitMs > 25_000;
    return (
      <Panel title={`Joining ${creds.roomCode}…`}>
        <div className="spinner" aria-hidden />
        <p className="muted">{coord.mesh.connectedPlayers().length === 0 ? "Looking for players in this room…" : "Connected — waiting for the host to admit you…"}</p>
        {long && (
          <>
            <p className="muted">Nobody answered yet. Check that the host still has the room open. The room may also be closed, or the invite key may be wrong.</p>
            <button onClick={() => go(`#/room?${new URLSearchParams({ r: creds.roomCode, k: creds.secret, e: String(creds.expiresAt), m: mode, new: "1" })}`)}>Re-open this room as host</button>
          </>
        )}
        <button className="ghost" onClick={() => go("#/")}>Cancel</button>
      </Panel>
    );
  }

  return (
    <div className="room">
      <TopBar coord={coord} st={st} session={session} go={go} onCustomize={() => setCustomizing(true)} />
      <div className="notices" aria-live="polite">
        {notices.map((n) => (
          <div key={n.id} className={`notice ${n.tone}`}>{n.text}</div>
        ))}
      </div>
      {v.migrating && st.phase !== "lobby" && <div className="banner warn">Host migration in progress — gameplay paused</div>}
      {v.migrating && st.phase === "lobby" && <div className="banner warn">Host unreachable — waiting for a majority of the room to reconnect</div>}
      {st.phase === "lobby" && <Lobby coord={coord} st={st} creds={creds} mode={mode} onCustomize={() => setCustomizing(true)} />}
      {(st.phase === "countdown" || st.phase === "playing") && <Match coord={coord} st={st} />}
      {st.phase === "ended" && <Results coord={coord} st={st} />}
      {customizing && <Customize embedded onClose={() => setCustomizing(false)} />}
      {(st.phase === "countdown" || st.phase === "playing") &&
        bubbles.map((b) => (
          <div key={b.id} className="callout-bubble" style={{ left: b.x, top: b.y }} aria-live="polite">
            {b.text}
          </div>
        ))}
    </div>
  );
}

function rectOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="center">
      <div className="panel">
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function TopBar({ coord, st, session, go, onCustomize }: { coord: Coordinator; st: RoomState; session: Session; go: (h: string) => void; onCustomize: () => void }) {
  const v = coord.view();
  return (
    <header className="topbar">
      <button className="brand" onClick={() => go("#/")} aria-label="Main menu"><LogoMark size={30} /></button>
      <div className="chip mono">{session.creds.roomCode}</div>
      <div className="chip hide-sm">{session.mode === "online" ? "WebRTC" : "Same device"}</div>
      <div className="chip hide-sm" title="Host epoch / log position">e{v.epoch} · #{v.lastSeq}{v.commit < v.lastSeq ? ` (${v.commit})` : ""}</div>
      <div className="grow" />
      <div className="chip ping-chip">
        <PingBadge coord={coord} pid={coord.playerId} hostId={v.isHost ? coord.playerId : v.hostId} label />
      </div>
      <div className="chip">{st.roster.length}/6</div>
      <button className="ghost small" onClick={onCustomize} aria-label="Customize">🎨</button>
      <button
        className="ghost small"
        onClick={() => {
          if (st.phase === "playing" && !confirm("Leaving now forfeits the match. Leave?")) return;
          session.close();
          go("#/");
        }}
      >
        Leave
      </button>
    </header>
  );
}

function Lobby({ coord, st, creds, mode, onCustomize }: { coord: Coordinator; st: RoomState; creds: RoomCredentials; mode: NetMode; onCustomize: () => void }) {
  const v = coord.view();
  const me = st.roster.find((r) => r.playerId === coord.playerId);
  const link = useMemo(() => {
    const base = buildInviteUrl(location.origin + location.pathname.replace(/\/$/, ""), creds);
    return mode === "local" ? base.replace("#/join?", "#/join?m=local&") : base;
  }, [creds, mode]);
  const [copied, setCopied] = useState(false);
  const can = coord.canStart();
  return (
    <div className="lobby">
      <section className="panel">
        <div className="row between">
          <h2>Lobby</h2>
          <button className="ghost small" onClick={onCustomize}>Customize</button>
        </div>
        <ul className="roster">
          {st.roster.map((r) => {
            const c = fromWire(r.cosmetics);
            return (
              <li key={r.playerId} className={r.connected ? "" : "off"}>
                <span className="avatar">{c.avatar}</span>
                <span className="name">
                  <span className={`dot ${r.connected ? "on" : ""}`} />
                  {r.name}
                  <TierBadge tier={tierFromWire(r.cosmetics)} small />
                  {r.playerId === coord.playerId && <em> (you)</em>}
                  <span className="looks">
                    {labelOf(BLOCK_SKINS, c.block)} · {labelOf(FRAMES, c.frame)} · {labelOf(EFFECTS, c.effect)}
                  </span>
                </span>
                <MiniSkin wire={r.cosmetics} />
                {r.connected && r.playerId !== v.hostId && <PingBadge coord={coord} pid={r.playerId} hostId={v.hostId} />}
                {r.playerId === v.hostId && <span className="badge host">HOST</span>}
                {r.role === "spectator" && <span className="badge">SPECTATING</span>}
                {r.playerId !== v.hostId && <span className={`badge ${r.ready ? "ready" : ""}`}>{r.ready ? "READY" : "not ready"}</span>}
              </li>
            );
          })}
          {Array.from({ length: Math.max(0, 6 - st.roster.length) }, (_, i) => (
            <li key={`empty${i}`} className="empty">
              <span className="avatar">·</span>
              <span className="name muted">Open slot</span>
            </li>
          ))}
        </ul>
        <div className="row">
          {!v.isHost && me && (
            <button className={me.ready ? "ghost" : ""} onClick={() => coord.setReady(!me.ready)}>
              {me.ready ? "Not ready" : "Ready"}
            </button>
          )}
          {v.isHost && (
            <button disabled={!can.ok} onClick={() => coord.startMatch()} title={can.reason}>
              Start match
            </button>
          )}
          {v.isHost && !can.ok && <span className="muted small">{can.reason}</span>}
        </div>
      </section>
      <section className="panel invite">
        <h3>Invite friends</h3>
        <label>Room code</label>
        <div className="big mono">{creds.roomCode}</div>
        <label>Invite key</label>
        <div className="big mono">{formatSecret(creds.secret)}</div>
        <p className="muted small">The code alone can't get anyone in — they need the key too. The link carries both in the part after #, which never reaches any server.</p>
        <div className="row">
          <button
            onClick={async () => {
              const flash = () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              };
              try {
                if (navigator.share) return void (await navigator.share({ title: "Stack Knockout", url: link }));
                if (navigator.clipboard) {
                  await navigator.clipboard.writeText(link);
                  return flash();
                }
              } catch {
                /* dismissed or blocked: fall through */
              }
              // Insecure pages (http://192.168…) have no share/clipboard API.
              const ta = document.createElement("textarea");
              ta.value = link;
              ta.style.position = "fixed";
              ta.style.opacity = "0";
              document.body.appendChild(ta);
              ta.select();
              const ok = document.execCommand("copy");
              ta.remove();
              if (ok) flash();
              else window.prompt("Copy this invite link:", link);
            }}
          >
            {copied ? "Copied!" : "Share invite link"}
          </button>
        </div>
      </section>
    </div>
  );
}

/** Four blocks in a player's chosen skin and colours. */
function MiniSkin({ wire }: { wire: Record<string, string> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const key = JSON.stringify(wire);
  useEffect(() => {
    if (!ref.current) return;
    const look = lookOf(fromWire(wire));
    const s = 14;
    const values = [3, 1, 5, 8];
    const ctx = sizeCanvas(ref.current, values.length, 1, s);
    ctx.clearRect(0, 0, values.length * s, s);
    values.forEach((v, i) => drawBlock(ctx, i * s, 0, s, v, look, 0, i, 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <canvas ref={ref} className="mini-skin" aria-hidden />;
}

// ===================================================================== match

/** Who a player's next attack goes to, as far as we can tell. */
function effectiveTarget(st: RoomState, pid: string): string | null {
  const m = st.match!;
  const mp = m.players[pid];
  if (!mp) return null;
  const alive = (p: string | null) => !!p && p !== pid && !!m.players[p]?.alive;
  if (mp.targetMode === "manual" && alive(mp.manualTarget)) return mp.manualTarget;
  if (mp.targetMode === "revenge" && alive(mp.lastAttacker)) return mp.lastAttacker;
  return alive(mp.lastTarget) ? mp.lastTarget : null;
}

function OpponentBoard({ coord, st, pid, size, targeted, onTarget, showHints = false, coached = false }: { coord: Coordinator; st: RoomState; pid: string; size: number; targeted: boolean; onTarget?: () => void; showHints?: boolean; coached?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const mp = st.match!.players[pid]!;
  const r = st.roster.find((x) => x.playerId === pid);
  const cos = fromWire(r?.cosmetics);
  const live = useRef({ mp, r, cos, size, showHints });
  live.current = { mp, r, cos, size, showHints };
  const prefs = usePrefs();
  const still = useRef(prefs.reduceMotion);
  still.current = prefs.reduceMotion;

  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const c = ref.current;
      if (!c) return;
      const { mp: p, r: ro, cos: cs, size: sz, showHints: hints } = live.current;
      const view = opponentView(coord, pid, p.sim);
      drawBoard(c, {
        board: view.board,
        size: sz,
        look: lookOf(cs),
        active: p.alive ? view.active : null,
        dim: !p.alive || !ro?.connected,
        label: !p.alive ? `#${p.placement}` : !ro?.connected ? "offline" : undefined,
        time: t,
        still: still.current || sz < 10,
        hints: hints && p.alive ? coord.suggestionsFor(pid).map((s) => ({ piece: s.piece, color: coachColor(s.from) })) : undefined,
      });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [coord, pid]);

  const queued = mp.incoming.reduce((a, g) => a + g.lines, 0);
  const landing = mp.commanded.reduce((a, g) => a + g.lines, 0);
  return (
    <button
      className={`opp ${targeted ? "targeted" : ""} ${coached ? "coached" : ""} ${mp.alive ? "" : "out"}`}
      onClick={onTarget}
      disabled={!mp.alive || !onTarget}
      aria-label={`${r?.name ?? "Player"}${targeted ? " (your target)" : ""}${coached ? " (coaching)" : ""}`}
    >
      <div className={`opp-well frame frame-${cos.frame}`} data-board={pid}>
        <canvas ref={ref} />
        {targeted && <span className="crosshair" aria-hidden>◎</span>}
      </div>
      <div className="opp-meta">
        <span className="name">
          {cos.avatar} {r?.name ?? "?"}
        </span>
        {mp.alive && r?.connected && <PingBadge coord={coord} pid={pid} hostId={coord.view().hostId} minMs={150} />}
        {(queued > 0 || landing > 0) && <span className="warn">+{queued + landing}</span>}
      </div>
    </button>
  );
}

/**
 * What to draw for another player right now: the board from the log, plus
 * the piece they just locked if the host's entry for it hasn't arrived yet
 * (it comes one hop later). Display only; the log replaces it.
 */
function opponentView(coord: Coordinator, pid: string, sim: PlayerSim): { board: Uint8Array; active: PiecePos | null } {
  const placed = sim.s.piecesPlaced;
  const now = performance.now();
  const lk = coord.remoteLocks.get(pid);
  const rp = coord.remotePieces.get(pid);
  // A newer preview of that same piece means the host rejected the lock and they were reset.
  const pending = !!lk && lk.idx === placed && now - lk.at < 2000 && !(rp && rp.idx === placed && rp.at > lk.at);
  let board = sim.s.board;
  if (pending) {
    board = board.slice();
    writePiece(board, lk.piece);
    clearLines(board);
  }
  const want = pending ? placed + 1 : placed;
  return { board, active: rp && rp.idx === want && now - rp.at < 1500 ? rp.piece : null };
}

function Rankings({ coord, st }: { coord: Coordinator; st: RoomState }) {
  const m = st.match!;
  const rows = m.participants
    .map((pid) => ({ pid, p: m.players[pid]! }))
    .sort((a, b) => (a.p.alive !== b.p.alive ? (a.p.alive ? -1 : 1) : a.p.alive ? b.p.kos - a.p.kos || b.p.attackSent - a.p.attackSent : (a.p.placement ?? 9) - (b.p.placement ?? 9)));
  const myTarget = effectiveTarget(st, coord.playerId);
  const attackingMe = new Set(m.participants.filter((p) => effectiveTarget(st, p) === coord.playerId));
  return (
    <ol className="rankings" aria-label="Rankings">
      {rows.map(({ pid, p }) => {
        const r = st.roster.find((x) => x.playerId === pid);
        const c = fromWire(r?.cosmetics);
        return (
          <li key={pid} className={`${pid === coord.playerId ? "me" : ""} ${p.alive ? "" : "out"}`}>
            <span className="rank">{p.alive ? "•" : `#${p.placement}`}</span>
            <span className="avatar">{c.avatar}</span>
            <span className="name">{r?.name ?? "(left)"}</span>
            {pid === myTarget && <span className="tag-target" title="Your target">◎</span>}
            {attackingMe.has(pid) && <span className="tag-threat" title="Targeting you">⚠</span>}
            {p.alive && r?.connected && <PingBadge coord={coord} pid={pid} hostId={coord.view().hostId} />}
            <span className="ko">{p.kos} KO</span>
          </li>
        );
      })}
    </ol>
  );
}

function useCountdown(st: RoomState): string | null {
  const [now, setNow] = useState(performance.now());
  const startedAt = useRef<number | null>(null);
  const goAt = useRef<number | null>(null);
  const lastSaid = useRef<string | null>(null);
  if (st.phase === "countdown" && startedAt.current === null) startedAt.current = performance.now();
  if (st.phase === "playing" && startedAt.current !== null && goAt.current === null) goAt.current = performance.now();
  useEffect(() => {
    const t = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(t);
  }, []);
  let label: string | null = null;
  if (st.phase === "countdown" && startedAt.current !== null) label = String(Math.max(1, 3 - Math.floor((now - startedAt.current) / 1000)));
  else if (goAt.current !== null && now - goAt.current < 700) label = "GO!";
  useEffect(() => {
    if (label === lastSaid.current) return;
    lastSaid.current = label;
    if (label === "GO!") audio.play("go");
    else if (label) audio.play("count");
  }, [label]);
  return label;
}

function Match({ coord, st }: { coord: Coordinator; st: RoomState }) {
  const v = coord.view();
  const m = st.match!;
  const me = coord.playerId;
  const meMp: MatchPlayer | undefined = m.players[me];
  const opponents = m.participants.filter((p) => p !== me);
  const elapsed = m.elapsedMs / 1000;
  const gravityMs = Math.max(90, 1000 * Math.pow(0.9, elapsed / 15));
  const countdown = useCountdown(st);
  const prefs = usePrefs();
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const fit = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  const narrow = viewport.w < 760;
  const touch = isTouchDevice();
  // Fit the board: height minus top bar, opponent strip (phones) and touch pad.
  const reservedH = 120 + (narrow ? 96 : 0) + (touch && prefs.touchMode !== "gestures" ? 190 : 0);
  const byHeight = Math.floor((viewport.h - reservedH) / 20);
  const byWidth = Math.floor((viewport.w - (narrow ? 130 : 520)) / 10);
  const cell = Math.max(14, Math.min(32, byHeight, byWidth));
  const oppSize = narrow ? Math.max(4, Math.min(6, Math.floor((viewport.w - 24) / (opponents.length * 11)))) : opponents.length > 3 ? 9 : 11;

  const overlay = v.abandoned
    ? "No result"
    : v.migrating
      ? "Migrating host…"
      : v.resumeInMs > 0
        ? `Resuming ${Math.ceil(v.resumeInMs / 1000)}…`
        : meMp && !meMp.alive
          ? `Out — #${meMp.placement}`
          : st.phase === "countdown"
            ? " "
            : null;
  const alive = m.participants.filter((p) => m.players[p]!.alive).length;
  const myTarget = effectiveTarget(st, me);
  const queued = meMp?.incoming.reduce((a, g) => a + g.lines, 0) ?? 0;
  const landing = coord.pendingGarbageForMe().reduce((a, g) => a + g.lines, 0);
  const spectating = !meMp || !meMp.alive;
  const [coachPick, setCoachPick] = useState<string | null>(null);
  // Only coach someone who is still in: drop the pick when they're knocked out.
  const coaching = spectating && coachPick && m.players[coachPick]?.alive ? coachPick : null;
  const hints: PlayfieldHint[] = prefs.coaching
    ? coord.suggestionsFor(me).map((s) => {
        const ro = st.roster.find((x) => x.playerId === s.from);
        return { coach: s.from, idx: s.idx, usedHold: s.usedHold, piece: s.piece, color: coachColor(s.from), label: `${fromWire(ro?.cosmetics).avatar} ${ro?.name ?? "Coach"}` };
      })
    : [];

  const onLock = (p: Placement) => {
    const incoming = coord.pendingGarbageForMe().reduce((a, g) => a + g.lines, 0);
    const r = coord.submitPlacement(p);
    if (r && r.lines === 0 && incoming > 0) {
      audio.play("garbageIn");
      fx.shake(boardEl(me), Math.min(0.8, 0.25 + incoming * 0.06));
    }
    return r;
  };

  const clock = `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`;
  const targetBar = meMp && meMp.alive && (
    <div className="targeting">
      <span className="muted small">Target</span>
      {(["random", "revenge"] as const).map((mode) => (
        <button key={mode} className={`small ${meMp.targetMode === mode ? "on" : "ghost"}`} onClick={() => coord.setTarget(mode)}>
          {mode}
        </button>
      ))}
      <span className="muted small">{meMp.targetMode === "manual" ? "manual — tap another board to switch" : "or tap a board"}</span>
    </div>
  );

  if (spectating) {
    const size = coaching
      ? Math.max(6, Math.min(10, Math.floor((viewport.w - 60) / (Math.min(5, m.participants.length) * 12))))
      : Math.max(8, Math.min(16, Math.floor((viewport.w - 60) / (Math.min(3, m.participants.length) * 12))));
    const canCoachAny = st.phase === "playing" && m.participants.some((p) => coord.canCoach(p));
    return (
      <div className="match spectate">
        <div className="spectate-head">
          <h3>{meMp ? `You placed #${meMp.placement} — spectating` : "Spectating — you'll play next round"}</h3>
          <span className="muted small">{alive} alive · {clock}</span>
          {canCoachAny && !coaching && <p className="coach-prompt">💡 Tap a board to coach that player — suggest where to drop their piece</p>}
        </div>
        {coaching && <CoachPanel key={coaching} coord={coord} st={st} pid={coaching} viewport={viewport} onClose={() => setCoachPick(null)} />}
        <div className="spectate-grid">
          {m.participants.map((pid) => (
            <OpponentBoard
              key={pid}
              coord={coord}
              st={st}
              pid={pid}
              size={size}
              targeted={false}
              coached={pid === coaching}
              showHints
              onTarget={coord.canCoach(pid) ? () => setCoachPick(pid === coaching ? null : pid) : undefined}
            />
          ))}
        </div>
        <CalloutBar coord={coord} st={st} />
        <Rankings coord={coord} st={st} />
      </div>
    );
  }

  return (
    <div className={`match ${narrow ? "narrow" : ""}`}>
      {!narrow && (
        <aside className="match-side">
          <div className="muted small">{alive} alive · {clock}</div>
          <Rankings coord={coord} st={st} />
        </aside>
      )}
      {narrow && (
        <div className="opp-strip">
          {opponents.map((pid) => (
            <OpponentBoard key={pid} coord={coord} st={st} pid={pid} size={oppSize} targeted={pid === myTarget} onTarget={() => coord.setTarget("manual", pid)} />
          ))}
        </div>
      )}
      <div className="mine">
        <Playfield
          sim={v.localSim!}
          getSim={() => coord.view().localSim}
          paused={v.paused}
          gravityMs={gravityMs}
          cellSize={cell}
          incomingQueued={queued}
          incomingLanding={landing}
          onLock={onLock}
          onPiece={(p) => coord.publishLivePiece(p)}
          overlay={overlay}
          boardId={me}
          hints={hints}
          onHintUsed={(h) => coord.tookSuggestion(h.coach)}
        >
          {countdown && <div className={`countdown ${countdown === "GO!" ? "go" : ""}`} key={countdown}>{countdown}</div>}
        </Playfield>
        {targetBar}
        <CalloutBar coord={coord} st={st} />
      </div>
      {!narrow && (
        <div className="opponents">
          <div className="opp-grid">
            {opponents.map((pid) => (
              <OpponentBoard key={pid} coord={coord} st={st} pid={pid} size={oppSize} targeted={pid === myTarget} onTarget={() => coord.setTarget("manual", pid)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ================================================================ coaching

/** Alive player with the most KOs (then most attack sent): who a "focus" call from a spectator names. */
function leaderOf(st: RoomState): string | null {
  const m = st.match!;
  const alive = m.participants.filter((p) => m.players[p]!.alive);
  alive.sort((a, b) => m.players[b]!.kos - m.players[a]!.kos || m.players[b]!.attackSent - m.players[a]!.attackSent);
  return alive[0] ?? null;
}

/** Quick callouts: tap an emoji, or press 1–6. */
function CalloutBar({ coord, st }: { coord: Coordinator; st: RoomState }) {
  const me = coord.playerId;
  const meMp = st.match?.players[me];
  const about = meMp?.alive ? effectiveTarget(st, me) : leaderOf(st);
  const [cool, setCool] = useState(false);
  const live = useRef({ about, cool });
  live.current = { about, cool };
  const send = (code: string) => {
    if (live.current.cool) return;
    if (coord.sendCallout(code, code === "focus" ? live.current.about : null)) {
      setCool(true);
      window.setTimeout(() => setCool(false), 900);
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const n = /^Digit([1-9])$/.exec(e.code)?.[1];
      const c = n ? CALLOUTS[Number(n) - 1] : undefined;
      if (c) {
        e.preventDefault();
        sendRef.current(c.code);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const aboutName = about ? st.roster.find((r) => r.playerId === about)?.name ?? null : null;
  return (
    <div className="callouts" role="toolbar" aria-label="Callouts">
      {CALLOUTS.map((c, i) => (
        <button key={c.code} className="ghost small callout" disabled={cool} onClick={() => send(c.code)} title={`${c.text(c.code === "focus" ? aboutName : null)} (${i + 1})`} aria-label={c.text(c.code === "focus" ? aboutName : null)}>
          {c.emoji}
        </button>
      ))}
    </div>
  );
}

/** The player's falling piece as last broadcast, if it's current. */
function livePieceOf(coord: Coordinator, pid: string, idx: number): PiecePos | null {
  const rp = coord.remotePieces.get(pid);
  return rp && rp.idx === idx && performance.now() - rp.at < 1500 ? rp.piece : null;
}

interface Draft {
  idx: number;
  usedHold: boolean;
  x: number;
  rot: Rotation;
}

/**
 * A knocked-out player coaching a live one: move/rotate a ghost of their
 * current piece on a big copy of their board and send it as a suggestion.
 */
function CoachPanel({ coord, st, pid, viewport, onClose }: { coord: Coordinator; st: RoomState; pid: string; viewport: { w: number; h: number }; onClose: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const me = coord.playerId;
  const mp = st.match!.players[pid]!;
  const ro = st.roster.find((r) => r.playerId === pid);
  const cos = fromWire(ro?.cosmetics);
  const sim = mp.sim;
  const idx = sim.s.piecesPlaced;
  const board = sim.s.board;
  const holdType = sim.holdSwapType();
  const canHold = holdType !== sim.s.active;
  const myColor = coachColor(me);
  const prefs = usePrefs();

  const initial = (): Draft => {
    // If they've already pressed hold, coach the piece they're actually holding now.
    const usedHold = canHold && livePieceOf(coord, pid, idx)?.type === holdType;
    return { idx, usedHold, x: spawnPos(usedHold ? holdType : sim.s.active).x, rot: 0 };
  };
  const [draft, setDraft] = useState<Draft>(initial);
  const [sentFor, setSentFor] = useState<number | null>(null);
  // A new piece for them: start a fresh draft.
  const d = draft.idx === idx ? draft : initial();
  useEffect(() => {
    if (draft.idx !== idx) setDraft(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx]);
  const type = d.usedHold ? holdType : sim.s.active;
  const piece = dropAt(board, type, d.x, d.rot);
  const ok = !!piece && reachable(board, piece);
  const sent = sentFor === idx;

  const live = useRef({ d, piece, board, type, canHold, idx, ok });
  live.current = { d, piece, board, type, canHold, idx, ok };

  const fit = (next: Draft): Draft | null => {
    const t = next.usedHold ? holdType : sim.s.active;
    // Like a wall kick: nudge sideways if the rotated piece doesn't fit here.
    for (const dx of [0, -1, 1, -2, 2]) if (dropAt(live.current.board, t, next.x + dx, next.rot)) return { ...next, x: next.x + dx };
    return null;
  };
  const act = useRef<(a: "left" | "right" | "cw" | "ccw" | "hold" | "best" | "send") => void>(() => {});
  act.current = (a) => {
    const { d: cur, board: b, canHold: ch, idx: i, piece: pc, ok: good } = live.current;
    const set = (n: Draft | null) => {
      if (!n) return;
      setDraft(n);
      setSentFor(null);
    };
    switch (a) {
      case "left":
      case "right": {
        const n = { ...cur, x: cur.x + (a === "left" ? -1 : 1) };
        if (dropAt(b, n.usedHold ? holdType : sim.s.active, n.x, n.rot)) set(n);
        return;
      }
      case "cw":
      case "ccw":
        return set(fit({ ...cur, rot: ((cur.rot + (a === "cw" ? 1 : 3)) % 4) as Rotation }));
      case "hold":
        if (ch) set(fit({ ...cur, usedHold: !cur.usedHold, x: spawnPos(cur.usedHold ? sim.s.active : holdType).x, rot: 0 }));
        return;
      case "best": {
        const best = bestSuggestion(sim);
        if (best) set({ idx: i, usedHold: best.usedHold, x: best.piece.x, rot: best.piece.rot });
        return;
      }
      case "send":
        if (pc && good && coord.suggestPlacement(pid, { idx: i, usedHold: cur.usedHold, piece: pc })) {
          setSentFor(i);
          audio.play("click");
        }
        return;
    }
  };

  useEffect(() => {
    const keys: Record<string, Parameters<typeof act.current>[0]> = {
      ArrowLeft: "left", ArrowRight: "right", ArrowUp: "cw", KeyX: "cw", KeyZ: "ccw", KeyC: "hold", ShiftLeft: "hold", KeyB: "best", Enter: "send", Space: "send",
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.code === "Escape") return onClose();
      const a = keys[e.code];
      if (!a) return;
      e.preventDefault();
      act.current(a);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cell = Math.max(14, Math.min(26, Math.floor((viewport.h - 330) / 20), Math.floor((viewport.w - 40) / 10)));
  const look = lookOf(cos);
  const drawState = useRef({ piece, look, cell, still: prefs.reduceMotion });
  drawState.current = { piece, look, cell, still: prefs.reduceMotion };
  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const c = ref.current;
      const p = st.match?.players[pid];
      if (!c || !p) return;
      const ds = drawState.current;
      const others = coord.suggestionsFor(pid).filter((s) => s.from !== me).map((s) => ({ piece: s.piece, color: coachColor(s.from) }));
      drawBoard(c, {
        board: p.sim.s.board,
        size: ds.cell,
        look: ds.look,
        active: livePieceOf(coord, pid, p.sim.s.piecesPlaced),
        time: t,
        still: ds.still,
        hints: ds.piece ? [...others, { piece: ds.piece, color: myColor, primary: true }] : others,
      });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coord, pid, st]);

  // Tap a column to move the suggestion there.
  const onBoardTap = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const col = Math.floor(((e.clientX - r.left) / r.width) * 10);
    const cells = pieceCells({ type, x: 0, y: 0, rot: d.rot } as PiecePos);
    const mid = Math.round(cells.reduce((a, [x]) => a + x, 0) / cells.length - 0.01);
    const n = fit({ ...d, x: col - mid });
    if (n) {
      setDraft(n);
      setSentFor(null);
    }
  };

  const others = coord.suggestionsFor(pid).filter((s) => s.from !== me);
  const btn = (a: Parameters<typeof act.current>[0], label: string, title: string, extra = "") => (
    <button className={`small ${extra || "ghost"}`} onClick={() => act.current(a)} title={title} aria-label={title}>
      {label}
    </button>
  );
  return (
    <section className="coach panel" aria-label={`Coaching ${ro?.name ?? "player"}`}>
      <div className="row between">
        <h3>
          Coaching {cos.avatar} {ro?.name ?? "?"}
        </h3>
        <button className="ghost small" onClick={onClose} aria-label="Stop coaching">✕</button>
      </div>
      <div className="coach-body">
        <div className={`opp-well frame frame-${cos.frame}`}>
          <canvas ref={ref} onPointerDown={onBoardTap} className="board-canvas" />
        </div>
        <div className="coach-side">
          <div className="muted small">Piece: <b>{type}</b>{d.usedHold ? " (after hold)" : ""}</div>
          <div className="coach-pad">
            {btn("ccw", "↺", "Rotate counter-clockwise (Z)")}
            {btn("cw", "↻", "Rotate clockwise (X / ↑)")}
            {btn("left", "←", "Move left (←)")}
            {btn("right", "→", "Move right (→)")}
          </div>
          <div className="coach-pad two">
            {canHold && btn("hold", d.usedHold ? "Unhold" : "Hold", "Suggest using hold (C)", d.usedHold ? "on" : "")}
            {btn("best", "Auto", "Start from the bot's pick (B)")}
          </div>
          <button onClick={() => act.current("send")} disabled={!ok || sent} title="Send to player (Enter)">
            {sent ? "Sent ✓" : ok ? "Suggest" : "Can't reach"}
          </button>
          <p className="muted small">Tap a column or use the keys. It disappears once they lock this piece.</p>
          {others.length > 0 && (
            <ul className="coach-others">
              {others.map((s) => {
                const r = st.roster.find((x) => x.playerId === s.from);
                return (
                  <li key={s.from} style={{ ["--coach" as string]: coachColor(s.from) }}>
                    {fromWire(r?.cosmetics).avatar} {r?.name ?? "Coach"} suggested too
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function Results({ coord, st }: { coord: Coordinator; st: RoomState }) {
  const v = coord.view();
  const res = st.lastResult;
  const who = (pid: string) => st.roster.find((r) => r.playerId === pid);
  const won = res?.winner === coord.playerId;
  // Count this match toward career score / stats once the result is confirmed.
  useEffect(() => {
    if (!res || !(v.matchEndCommitted || res.reason === "no-contest")) return;
    const mine = res.rankings.find((r) => r.playerId === coord.playerId);
    if (!mine) return;
    recordGame({
      id: res.matchId,
      score: mine.score,
      kos: mine.kos,
      attackSent: mine.attackSent,
      won: res.reason === "knockout" && res.winner === coord.playerId,
      players: res.rankings.length,
    });
  }, [res, v.matchEndCommitted, coord]);
  return (
    <div className="center">
      <div className={`panel results ${won ? "won" : ""}`}>
        <h2>{res?.reason === "no-contest" ? "No result" : won ? "Victory!" : `${res?.winner ? who(res.winner)?.name ?? "Someone" : "Nobody"} wins`}</h2>
        {!v.matchEndCommitted && <p className="muted small">Confirming result with the room…</p>}
        <table>
          <thead>
            <tr><th>#</th><th>Player</th><th>KOs</th><th>Sent</th><th className="hide-sm">Lines</th><th>Score</th></tr>
          </thead>
          <tbody>
            {res?.rankings.map((r) => {
              const ro = who(r.playerId);
              return (
                <tr key={r.playerId} className={r.playerId === coord.playerId ? "me" : ""}>
                  <td>{r.placement === 1 ? "🏆" : r.placement}</td>
                  <td>{fromWire(ro?.cosmetics).avatar} {ro?.name ?? "(left)"}</td>
                  <td>{r.kos}</td>
                  <td>{r.attackSent}</td>
                  <td className="hide-sm">{r.lines}</td>
                  <td>{r.score.toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="row">
          {v.isHost ? <button onClick={() => coord.rematch()}>Rematch</button> : <span className="muted">Waiting for the host to start a rematch…</span>}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useReducer, useRef, useState } from "react";
import { LogoMark } from "../ui/Logo";
import { drawBoard } from "../render/draw";
import { LabCluster, type LabNode } from "./LabCluster";

const NAMES = ["Ana", "Ben", "Cai", "Dee", "Eli", "Fay"];

/**
 * Migration Lab: six real coordinators with bots on a simulated network, all
 * in this tab. Kill, disconnect or partition players and watch host election,
 * recovery and split-brain protection happen.
 */
export function Lab({ go }: { go: (h: string) => void }) {
  const lab = useRef<LabCluster | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [speed, setSpeed] = useState(1);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  if (!lab.current) lab.current = new LabCluster(NAMES);
  const L = lab.current;

  useEffect(() => {
    let last = performance.now();
    let raf = 0;
    let started = false;
    let frames = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(100, t - last) * speedRef.current;
      last = t;
      L.step(dt);
      if (!started && L.nodes[0]!.coord.view().state?.roster.length === NAMES.length) {
        L.autoLobby();
        if (L.nodes[0]!.coord.canStart().ok) {
          L.nodes[0]!.coord.startMatch();
          started = true;
        }
      }
      if (++frames % 3 === 0) bump();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [L]);

  const host = L.host();
  const live = L.nodes.filter((n) => !n.closed);
  // Peers are always a few in-flight entries apart during live play, so compare
  // who they follow (epoch + host) and how far behind the slowest one is.
  const online = live.filter((n) => n.online).map((n) => n.coord.view());
  const leaders = new Set(online.map((v) => `${v.epoch}:${v.hostId ?? "-"}`));
  const lag = online.length ? Math.max(...online.map((v) => v.lastSeq)) - Math.min(...online.map((v) => v.lastSeq)) : 0;
  const agree = leaders.size === 1 && online.every((v) => v.hostId);
  const h = host?.coord.view();

  return (
    <div className="lab">
      <header className="topbar">
        <button className="brand" onClick={() => go("#/")} aria-label="Main menu"><LogoMark size={30} /></button>
        <strong>Migration Lab</strong>
        <span className="chip">host: {host?.name ?? "none"}</span>
        <span className="chip">epoch {h?.epoch ?? "-"}</span>
        <span className={`chip ${agree ? "good" : "warn"}`}>{agree ? `all online peers follow ${host?.name ?? "the host"} · lag ${lag}` : `${leaders.size} different views of the host`}</span>
        <div className="grow" />
        <label className="small">speed</label>
        {[1, 2, 4].map((s) => (
          <button key={s} className={`small ${speed === s ? "on" : "ghost"}`} onClick={() => setSpeed(s)}>{s}×</button>
        ))}
      </header>
      <div className="lab-actions">
        <button onClick={() => host && L.setOnline(host, false)} disabled={!host}>Host loses Wi-Fi</button>
        <button onClick={() => host && L.closeTab(host)} disabled={!host}>Host closes tab</button>
        <button onClick={() => L.partition([NAMES.slice(0, 3), NAMES.slice(3)])}>Split 3 | 3</button>
        <button onClick={() => { const hn = host?.name ?? NAMES[0]!; const others = NAMES.filter((n) => n !== hn); L.partition([[hn, others[0]!], others.slice(1)]); }}>Split 2 (with host) | 4</button>
        <button onClick={() => L.heal()}>Heal network</button>
        {h?.state?.phase === "ended" && <button onClick={() => host!.coord.rematch()}>Rematch</button>}
        {h?.state?.phase === "lobby" && <button onClick={() => { L.autoLobby(); window.setTimeout(() => host?.coord.startMatch(), 300); }}>Start</button>}
      </div>
      <div className="lab-grid">
        {L.nodes.map((n) => (
          <LabCard key={n.name} lab={L} n={n} />
        ))}
      </div>
      <pre className="lab-log">{L.log.join("\n")}</pre>
    </div>
  );
}

function LabCard({ lab, n }: { lab: LabCluster; n: LabNode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const v = n.coord.view();
  const mp = v.state?.match?.players[n.pid];
  useEffect(() => {
    if (!ref.current) return;
    const sim = v.localSim;
    drawBoard(ref.current, {
      board: sim?.s.board ?? new Uint8Array(400),
      size: 11,
      dim: n.closed || !n.online || v.paused,
      label: n.closed ? "tab closed" : !n.online ? "offline" : v.migrating ? "electing…" : v.abandoned ? "no result" : mp && !mp.alive ? `out #${mp.placement}` : v.phase !== "playing" ? v.phase : v.paused ? "paused" : undefined,
    });
  });
  return (
    <div className={`panel lab-card ${v.isHost ? "is-host" : ""}`}>
      <div className="row between">
        <strong>{n.name}</strong>
        <span className={`badge ${v.isHost ? "host" : ""}`}>{n.closed ? "closed" : v.mode}</span>
      </div>
      <canvas ref={ref} />
      <div className="mono small muted">e{v.epoch} #{v.lastSeq} c{v.commit}</div>
      <div className="row">
        {!n.closed && <button className="small ghost" onClick={() => lab.setOnline(n, !n.online)}>{n.online ? "Disconnect" : "Reconnect"}</button>}
        {!n.closed ? <button className="small ghost" onClick={() => lab.closeTab(n)}>Close</button> : <button className="small" onClick={() => lab.reopen(n)}>Reopen</button>}
      </div>
    </div>
  );
}

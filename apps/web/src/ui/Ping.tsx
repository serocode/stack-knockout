import { useEffect, useState } from "react";
import type { Coordinator } from "@tk/coordinator";

export type PingQuality = "good" | "ok" | "bad";

export const pingQuality = (ms: number): PingQuality => (ms <= 80 ? "good" : ms <= 160 ? "ok" : "bad");

const HELP =
  "Round trip to the host. Your own moves are instant; other players' moves, garbage and KOs reach you about this much later.";

/** Re-read the coordinator's ping once a second (pings change without any room event). */
export function usePing(coord: Coordinator, pid: string): number | null {
  const [ms, setMs] = useState(() => coord.pingToHost(pid));
  useEffect(() => {
    setMs(coord.pingToHost(pid));
    const t = window.setInterval(() => setMs(coord.pingToHost(pid)), 1000);
    return () => window.clearInterval(t);
  }, [coord, pid]);
  return ms;
}

/**
 * A player's ping to the host. `minMs` hides it unless it's at least that
 * high (for cramped places where only lag is worth showing).
 */
export function PingBadge({ coord, pid, hostId, minMs = 0, label = false }: { coord: Coordinator; pid: string; hostId: string | null; minMs?: number; label?: boolean }) {
  const ms = usePing(coord, pid);
  if (pid === hostId) return minMs > 0 ? null : <span className="ping host" title="Hosting: everyone's moves are checked here">{label ? "📶 host" : "host"}</span>;
  if (ms === null) return minMs > 0 ? null : <span className="ping" title={HELP}>{label ? "📶 " : ""}— ms</span>;
  if (ms < minMs) return null;
  const q = pingQuality(ms);
  return (
    <span className={`ping ${q}`} title={HELP} aria-label={`Ping ${ms} milliseconds${q === "bad" ? ", laggy" : ""}`}>
      <Bars q={q} />
      {label ? " " : ""}
      {ms} ms
    </span>
  );
}

function Bars({ q }: { q: PingQuality }) {
  const n = q === "good" ? 3 : q === "ok" ? 2 : 1;
  return (
    <svg className="ping-bars" viewBox="0 0 12 10" aria-hidden>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={i * 4} y={6 - i * 3} width="3" height={4 + i * 3} rx="0.6" opacity={i < n ? 1 : 0.25} />
      ))}
    </svg>
  );
}

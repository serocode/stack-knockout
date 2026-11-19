import { useState } from "react";
import { saveName, savedName } from "../lib/identity";
import { useRoomListings, type Listing } from "../lib/directory";

type Go = (h: string) => void;

const PHASE_LABEL: Record<Listing["phase"], string> = { lobby: "Waiting", countdown: "Starting", playing: "In game", ended: "Between rounds" };

/**
 * Waiting rooms: public rooms announced by their hosts. Joining one mid-game
 * puts you in as a spectator until the next round.
 */
export function RoomBrowser({ go }: { go: Go }) {
  const { rooms, error } = useRoomListings();
  const [name, setName] = useState(savedName());
  const [filter, setFilter] = useState<"all" | "ffa" | "teams">("all");
  const shown = rooms.filter((r) => filter === "all" || (filter === "teams") === r.teams);
  const join = (r: Listing) => {
    if (!name.trim()) return;
    saveName(name.trim());
    go(`#/room?${new URLSearchParams({ r: r.code, k: r.key, e: String(r.expiresAt), m: r.mode })}`);
  };
  return (
    <div className="page">
      <div className="panel rooms-panel">
        <div className="row between">
          <h2>Waiting rooms</h2>
          <button className="ghost small" onClick={() => go("#/")}>Back</button>
        </div>
        <p className="muted small">
          Public rooms show up here while their host keeps them listed. Anyone can join a listed room. To list your own, create a room and tick
          <b> List publicly</b> in its settings.
        </p>
        <label>Your name</label>
        <input value={name} maxLength={20} placeholder="Name" onChange={(e) => setName(e.target.value)} />
        <div className="seg" role="tablist" aria-label="Filter rooms">
          {(["all", "ffa", "teams"] as const).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={`small ${filter === f ? "on" : "ghost"}`} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "ffa" ? "Free-for-all" : "Teams"}
            </button>
          ))}
        </div>
        {error && <p className="warn small">Couldn't reach the room directory: {error}</p>}
        {shown.length === 0 ? (
          <div className="rooms-empty">
            <div className="spinner" aria-hidden />
            <p className="muted">Listening for rooms… New rooms appear here on their own.</p>
            <ul className="muted small rooms-help">
              <li>Only rooms whose host ticked <b>List in Waiting rooms</b> show up (it's on by default for new rooms).</li>
              <li><b>Same device only</b> rooms appear only in other tabs of the same browser.</li>
              <li>Vs Computer games are private and never listed.</li>
            </ul>
            <button onClick={() => go("#/create")}>Create a room instead</button>
          </div>
        ) : (
          <ul className="room-list">
            {shown.map((r) => {
              const full = r.players >= r.max;
              return (
                <li key={`${r.mode}-${r.code}`} className={`room-card ${r.phase === "lobby" ? "waiting" : ""}`}>
                  <span className="avatar big-avatar" aria-hidden>{r.avatar || "🎮"}</span>
                  <div className="room-card-body">
                    <b>{r.title || `${r.host}'s room`}</b>
                    <span className="muted small">
                      Host {r.host} · {r.teams ? "Teams" : "Free-for-all"} · {r.rounds === 1 ? "1 round" : `${r.rounds} rounds`}
                      {r.bombs ? " · 💣" : ""}
                      {r.mode === "local" ? " · this device" : ""}
                    </span>
                    <span className="room-card-tags">
                      <span className={`chip ${r.phase === "lobby" ? "good" : "warn"}`}>
                        {PHASE_LABEL[r.phase]}
                        {r.round > 0 && r.rounds > 1 ? ` · round ${r.round}/${r.rounds}` : ""}
                      </span>
                      <span className="chip">
                        {r.players}/{r.max} players
                      </span>
                    </span>
                  </div>
                  <button disabled={full || !name.trim()} onClick={() => join(r)} title={full ? "Room is full" : r.phase === "lobby" ? "Join" : "Join and spectate until the next round"}>
                    {full ? "Full" : r.phase === "lobby" ? "Join" : "Watch"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

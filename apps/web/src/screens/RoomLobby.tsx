import { useEffect, useMemo, useRef, useState } from "react";
import {
  BOMB_FREQUENCIES,
  MAX_PLAYERS,
  MAX_TEAM_SIZE,
  TEAM_IDS,
  type BombFrequency,
  type Coordinator,
  type MatchOptions,
  type RosterEntry,
  type RoomState,
  type TeamId,
  type TeamPick,
  TEAM_PICKS,
} from "@tk/coordinator";
import { BOMB_BLASTS, MAX_BOMB_BONUS, type BombBlast } from "@tk/engine";
import { buildInviteUrl, formatSecret, type RoomCredentials } from "@tk/net";
import { BLOCK_SKINS, EFFECTS, FRAMES, fromWire, labelOf, tierFromWire } from "../cosmetics/catalog";
import { CPU_LEVELS, MAX_CPU, type CpuLevel, type CpuOpponents } from "../lib/cpu";
import type { NetMode } from "../lib/session";
import { lookOf, sizeCanvas } from "../render/draw";
import { drawBlock } from "../render/skins";
import { ChatPanel, TEAM_INFO, TeamBadge } from "../ui/Chat";
import { PingBadge } from "../ui/Ping";
import { TierBadge } from "./Profile";

export const ROUND_CHOICES = [1, 3, 5, 7, 10] as const;

const BOMB_FREQ_LABEL: Record<BombFrequency, string> = { off: "Off", sparse: "One per batch", half: "Every other row", every: "Every row" };
const BLAST_LABEL: Record<BombBlast, { label: string; hint: string }> = {
  line: { label: "Line", hint: "Also clears the row beneath it" },
  area: { label: "Area", hint: "Destroys the 8 cells around it" },
  column: { label: "Column", hint: "Destroys everything below it" },
};

/** One-line summary of the room's bomb rules, e.g. "💣 Every row · Line · +1". */
export function bombSummary(o: MatchOptions): string | null {
  if (o.bombs === "off") return null;
  return `💣 ${BOMB_FREQ_LABEL[o.bombs]} · ${BLAST_LABEL[o.blast].label} blast${o.bombBonus ? ` · +${o.bombBonus} attack` : ""}`;
}

/** "Free-for-all · 3 rounds" */
export const TEAM_PICK_LABEL: Record<TeamPick, { label: string; hint: string }> = {
  choose: { label: "Players choose", hint: "Everyone picks a side; the host can move people." },
  random: { label: "Random", hint: "Teams are drawn at random when the series starts and kept for every round." },
  round: { label: "Random every round", hint: "New random teams before every round. The final ranking is by player." },
};

export function modeSummary(o: Pick<MatchOptions, "teams" | "rounds" | "teamPick">): string {
  const mode = o.teams ? `Teams (up to ${MAX_TEAM_SIZE} v ${MAX_TEAM_SIZE})${o.teamPick === "choose" ? "" : o.teamPick === "random" ? " · random teams" : " · random each round"}` : "Free-for-all";
  return `${mode} · ${o.rounds === 1 ? "1 round" : `${o.rounds} rounds`}`;
}

export function roomTitle(st: RoomState, hostId: string | null): string {
  if (st.options.title) return st.options.title;
  const host = st.roster.find((r) => r.playerId === hostId);
  return host ? `${host.name}'s room` : "Room";
}

/** Four blocks in a player's chosen skin and colours. */
export function MiniSkin({ wire }: { wire: Record<string, string> }) {
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

function PlayerRow({ coord, st, r, isBot, teams }: { coord: Coordinator; st: RoomState; r: RosterEntry; isBot: boolean; teams: boolean }) {
  const v = coord.view();
  const c = fromWire(r.cosmetics);
  const me = r.playerId === coord.playerId;
  const other: TeamId = r.team === 1 ? 2 : 1;
  const canMove = teams && (v.isHost || (me && st.options.teamPick === "choose")) && st.roster.filter((x) => x.team === other).length < MAX_TEAM_SIZE;
  return (
    <li className={`${r.connected ? "" : "off"} ${me ? "me" : ""}`}>
      <span className="avatar">{c.avatar}</span>
      <span className="name">
        <span className={`dot ${r.connected ? "on" : ""}`} />
        {r.name}
        <TierBadge tier={tierFromWire(r.cosmetics)} small />
        {me && <em> (you)</em>}
        {isBot && <span className="badge">CPU</span>}
        <span className="looks">
          {labelOf(BLOCK_SKINS, c.block)} · {labelOf(FRAMES, c.frame)} · {labelOf(EFFECTS, c.effect)}
        </span>
      </span>
      <MiniSkin wire={r.cosmetics} />
      {r.connected && r.playerId !== v.hostId && <PingBadge coord={coord} pid={r.playerId} hostId={v.hostId} />}
      {r.playerId === v.hostId && <span className="badge host">HOST</span>}
      {r.role === "spectator" && st.phase !== "lobby" && <span className="badge">WATCHING</span>}
      {r.playerId !== v.hostId && <span className={`badge ${r.ready ? "ready" : ""}`}>{r.ready ? "READY" : "not ready"}</span>}
      {canMove && (
        <button className="ghost small icon-btn" onClick={() => coord.setTeam(other, r.playerId)} title={`Move to ${TEAM_INFO[other].name}`} aria-label={`Move ${r.name} to ${TEAM_INFO[other].name}`}>
          ⇄ {TEAM_INFO[other].emblem}
        </button>
      )}
      {v.isHost && !me && !isBot && (
        <button
          className="ghost small icon-btn danger"
          onClick={() => confirm(`Remove ${r.name} from the room? They won't be able to rejoin it.`) && coord.kick(r.playerId)}
          title="Remove from room"
          aria-label={`Remove ${r.name}`}
        >
          ✕
        </button>
      )}
    </li>
  );
}

/** The roster: two team columns in a team room, one list otherwise. */
export function RosterView({ coord, st, cpu }: { coord: Coordinator; st: RoomState; cpu?: CpuOpponents }) {
  const teams = st.options.teams;
  const me = st.roster.find((r) => r.playerId === coord.playerId);
  // Random teams: the draw at start decides, so show one list instead of columns it would overwrite.
  const drawn = teams && st.options.teamPick !== "choose";
  if (!teams || drawn) {
    const open = MAX_PLAYERS - st.roster.length;
    return (
      <>
      {drawn && (
        <p className="draw-note">
          🎲 Teams are drawn at random {st.options.teamPick === "round" ? "before every round" : "when the series starts"} — {Math.ceil(st.roster.length / 2)} v {Math.floor(st.roster.length / 2)} with everyone here.
        </p>
      )}
      <ul className="roster">
        {st.roster.map((r) => (
          <PlayerRow key={r.playerId} coord={coord} st={st} r={r} isBot={!!cpu?.isBot(r.playerId)} teams={false} />
        ))}
        {open > 0 && (
          <li className="empty">
            <span className="avatar">·</span>
            <span className="name muted">{open === 1 ? "1 open slot" : `${open} open slots`}</span>
          </li>
        )}
      </ul>
      </>
    );
  }
  return (
    <div className="team-columns">
      {TEAM_IDS.map((t) => {
        const members = st.roster.filter((r) => r.team === t);
        const info = TEAM_INFO[t];
        return (
          <div key={t} className="team-col" style={{ ["--team" as string]: info.color }}>
            <div className="team-head">
              <b>
                <span aria-hidden>{info.emblem}</span> {info.name}
              </b>
              <span className="muted small">
                {members.length}/{MAX_TEAM_SIZE}
              </span>
              {me && me.team !== t && members.length < MAX_TEAM_SIZE && (
                <button className="ghost small" onClick={() => coord.setTeam(t)}>
                  Join
                </button>
              )}
            </div>
            <ul className="roster">
              {members.map((r) => (
                <PlayerRow key={r.playerId} coord={coord} st={st} r={r} isBot={!!cpu?.isBot(r.playerId)} teams />
              ))}
              {Array.from({ length: MAX_TEAM_SIZE - members.length }, (_, i) => (
                <li key={`e${i}`} className="empty">
                  <span className="avatar">·</span>
                  <span className="name muted">Open slot</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** Host-set rules: mode, rounds, listing, bombs. Everyone sees them; only the host changes them. */
function RoomSettings({ coord, st, mode }: { coord: Coordinator; st: RoomState; mode: NetMode }) {
  const v = coord.view();
  const editable = v.isHost;
  const options = st.options;
  const set = (patch: Partial<MatchOptions>) => coord.setOptions(patch);
  const [title, setTitle] = useState(options.title);
  useEffect(() => setTitle(options.title), [options.title]);
  const bombsOn = options.bombs !== "off";
  return (
    <section className="panel room-settings">
      <h3>Room settings</h3>
      {!editable && <p className="muted small">Only the host can change these.</p>}
      {editable && (
        <>
          <label>Room name</label>
          <input
            value={title}
            maxLength={28}
            placeholder={roomTitle({ ...st, options: { ...options, title: "" } }, v.hostId)}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title !== options.title && set({ title })}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </>
      )}
      <label>Mode</label>
      <div className="seg">
        <button className={`small ${!options.teams ? "on" : "ghost"}`} disabled={!editable} onClick={() => set({ teams: false })}>
          Free-for-all
        </button>
        <button className={`small ${options.teams ? "on" : "ghost"}`} disabled={!editable} onClick={() => set({ teams: true })}>
          Teams · up to {MAX_TEAM_SIZE}v{MAX_TEAM_SIZE}
        </button>
      </div>
      {options.teams && (
        <>
          <label>Teams</label>
          <div className="seg">
            {TEAM_PICKS.map((k) => (
              <button key={k} className={`small ${options.teamPick === k ? "on" : "ghost"}`} disabled={!editable} onClick={() => set({ teamPick: k })} title={TEAM_PICK_LABEL[k].hint}>
                {k === "choose" ? "" : "🎲 "}
                {TEAM_PICK_LABEL[k].label}
              </button>
            ))}
          </div>
          <p className="muted small">{TEAM_PICK_LABEL[options.teamPick].hint}</p>
          {editable && options.teamPick === "choose" && (
            <div className="seg">
              <button className="ghost small" onClick={() => coord.balanceTeams()}>Even out teams</button>
              <button className="ghost small" onClick={() => coord.shuffleTeams()}>Shuffle once</button>
            </div>
          )}
        </>
      )}
      <label>Rounds</label>
      <div className="seg">
        {ROUND_CHOICES.map((n) => (
          <button key={n} className={`small ${options.rounds === n ? "on" : "ghost"}`} disabled={!editable} onClick={() => set({ rounds: n })}>
            {n}
          </button>
        ))}
      </div>
      <p className="muted small">
        {options.teams
          ? "Points per round: +3 if your team wins, +1 if you're still standing, +1 per knockout."
          : "Points per round: 1 per player you outlast, +2 for the win, +1 per knockout."}{" "}
        {options.rounds > 1 && "Rankings show after every round; the next one starts by itself."}
      </p>
      {mode !== "cpu" && (
        <label className="check">
          <input type="checkbox" checked={options.listed} disabled={!editable} onChange={(e) => set({ listed: e.target.checked })} />
          <span>
            List publicly in Waiting rooms
            <span className="muted small"> — anyone browsing can see and join this room{mode === "local" ? " (on this device)" : ""}</span>
          </span>
        </label>
      )}
      <h3>Bomb garbage</h3>
      <p className="muted small">
        Some garbage rows carry a bomb. Clear a bomb's row and it blows up{bombsOn ? `: ${BLAST_LABEL[options.blast].hint.toLowerCase()}` : ""}. Bombs caught in a blast go off too.
      </p>
      <div className="seg">
        {BOMB_FREQUENCIES.map((f) => (
          <button key={f} className={`small ${options.bombs === f ? "on" : "ghost"}`} disabled={!editable} onClick={() => set({ bombs: f })}>
            {BOMB_FREQ_LABEL[f]}
          </button>
        ))}
      </div>
      {bombsOn && (
        <>
          <label>Blast</label>
          <div className="seg">
            {BOMB_BLASTS.map((b) => (
              <button key={b} className={`small ${options.blast === b ? "on" : "ghost"}`} disabled={!editable} title={BLAST_LABEL[b].hint} onClick={() => set({ blast: b })}>
                {BLAST_LABEL[b].label}
              </button>
            ))}
          </div>
          <label>Bonus attack per bomb</label>
          <div className="seg">
            {Array.from({ length: MAX_BOMB_BONUS + 1 }, (_, n) => (
              <button key={n} className={`small ${options.bombBonus === n ? "on" : "ghost"}`} disabled={!editable} onClick={() => set({ bombBonus: n })}>
                {n === 0 ? "None" : `+${n}`}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** Lobby panel for computer opponents: how many, and how tough. */
function CpuPanel({ cpu, st }: { cpu: CpuOpponents; st: RoomState }) {
  const [, bump] = useState(0);
  const refresh = () => bump((x) => x + 1);
  const room = MAX_PLAYERS - st.roster.length;
  return (
    <section className="panel invite">
      <h3>Computer opponents</h3>
      <label>Bots</label>
      <div className="row">
        <button className="small ghost" disabled={cpu.count <= 1} onClick={() => { cpu.remove(); refresh(); }} aria-label="Remove a bot">−</button>
        <div className="big mono">{cpu.count}</div>
        <button className="small ghost" disabled={cpu.count >= MAX_CPU || room <= 0} onClick={() => { cpu.add(); refresh(); }} aria-label="Add a bot">+</button>
      </div>
      <label>Difficulty</label>
      <div className="seg">
        {(Object.keys(CPU_LEVELS) as CpuLevel[]).map((l) => (
          <button key={l} className={`small ${cpu.level === l ? "on" : "ghost"}`} onClick={() => { cpu.setLevel(l); refresh(); }}>
            {CPU_LEVELS[l].label}
          </button>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={cpu.chatty} onChange={(e) => { cpu.chatty = e.target.checked; refresh(); }} />
        <span>Bots chat</span>
      </label>
      <p className="muted small">Bots play right here in your browser — no internet needed. In a team room, use ⇄ to move bots between teams.</p>
    </section>
  );
}

function InvitePanel({ creds, mode }: { creds: RoomCredentials; mode: NetMode }) {
  const link = useMemo(() => {
    const base = buildInviteUrl(location.origin + location.pathname.replace(/\/$/, ""), creds);
    return mode === "local" ? base.replace("#/join?", "#/join?m=local&") : base;
  }, [creds, mode]);
  const [copied, setCopied] = useState(false);
  return (
    <section className="panel invite">
      <h3>Invite friends</h3>
      <div className="invite-codes">
        <div>
          <label>Room code</label>
          <div className="big mono">{creds.roomCode}</div>
        </div>
        <div>
          <label>Invite key</label>
          <div className="big mono">{formatSecret(creds.secret)}</div>
        </div>
      </div>
      <p className="muted small">The code alone can't get anyone in — they need the key too. The link carries both after the #, which never reaches any server.</p>
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
  );
}

/**
 * The waiting room: who's here (by team), room settings, chat, and the
 * ready / start controls.
 */
export function WaitingRoom({ coord, st, creds, mode, cpu, onCustomize }: { coord: Coordinator; st: RoomState; creds: RoomCredentials; mode: NetMode; cpu?: CpuOpponents; onCustomize: () => void }) {
  const v = coord.view();
  const me = st.roster.find((r) => r.playerId === coord.playerId);
  const can = coord.canStart();
  const readyCount = st.roster.filter((r) => r.playerId !== v.hostId && r.ready).length;
  const others = st.roster.filter((r) => r.playerId !== v.hostId).length;
  const last = st.series?.done && st.series.standings.length ? st.series : null;
  return (
    <div className="waiting">
      <div className="waiting-main">
        <section className="panel">
          <div className="row between">
            <div>
              <h2 className="room-title">
                {roomTitle(st, v.hostId)}
                {st.options.teams && st.options.teamPick === "choose" && me && <TeamBadge team={me.team} label="name" className="title-badge" />}
              </h2>
              <div className="muted small">
                {modeSummary(st.options)}
                {bombSummary(st.options) ? ` · ${bombSummary(st.options)}` : ""}
                {st.options.listed && mode !== "cpu" ? " · 🌐 listed" : ""}
              </div>
            </div>
            <button className="ghost small" onClick={onCustomize}>Customize</button>
          </div>
          {last && (
            <p className="last-series small">
              Last series: <b>{last.standings[0]!.name}</b> topped the table with {last.standings[0]!.points} pts
              {last.endedEarly ? ` (stopped after ${last.played} of ${last.total})` : ""}.
            </p>
          )}
          <RosterView coord={coord} st={st} cpu={cpu} />
          <div className="row">
            {!v.isHost && me && (
              <button className={me.ready ? "ghost" : ""} onClick={() => coord.setReady(!me.ready)}>
                {me.ready ? "Not ready" : "Ready"}
              </button>
            )}
            {v.isHost && (
              <button disabled={!can.ok} onClick={() => coord.startMatch()} title={can.reason}>
                {st.options.rounds > 1 ? `Start ${st.options.rounds}-round series` : "Start match"}
              </button>
            )}
            <span className="muted small">{v.isHost && !can.ok ? can.reason : others > 0 ? `${readyCount}/${others} ready` : "Waiting for players…"}</span>
          </div>
        </section>
        <RoomSettings coord={coord} st={st} mode={mode} />
      </div>
      <div className="waiting-side">
        <ChatPanel coord={coord} st={st} title="Room chat" />
        {cpu ? <CpuPanel cpu={cpu} st={st} /> : <InvitePanel creds={creds} mode={mode} />}
      </div>
    </div>
  );
}

import { useEffect } from "react";
import { seriesWinnerTeam, wonResult, type Coordinator, type MatchResult, type RoomState, type Series, type SeriesStanding, type TeamId } from "@tk/coordinator";
import { fromWire } from "../cosmetics/catalog";
import { recordGame, recordSeries, type Achievement } from "../progress/profile";
import { ChatPanel, TEAM_INFO, TeamBadge } from "../ui/Chat";

const medal = (rank: number) => (rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : String(rank));

function avatarOf(st: RoomState, pid: string): string {
  return fromWire(st.roster.find((r) => r.playerId === pid)?.cosmetics).avatar;
}

function nameOf(st: RoomState, pid: string): string {
  return st.roster.find((r) => r.playerId === pid)?.name ?? st.series?.standings.find((s) => s.playerId === pid)?.name ?? "(left)";
}

function TeamDot({ team }: { team: number }) {
  return <TeamBadge team={team} label="none" className="mini" />;
}

/** Row style for a team match: a tinted stripe in the team's colour. */
const teamRow = (team: number | undefined) => (team === 1 || team === 2 ? { ["--team" as string]: TEAM_INFO[team as TeamId].color } : undefined);

/** "Sam wins" / "Red Team wins" / "No result" */
function headline(st: RoomState, res: MatchResult, me: string): string {
  if (res.reason === "no-contest") return "No result";
  if (res.winnerTeam) return wonResult(res, me) ? `${TEAM_INFO[res.winnerTeam].name} wins — that's you!` : `${TEAM_INFO[res.winnerTeam].name} wins`;
  if (res.winner === me) return "Victory!";
  return `${res.winner ? nameOf(st, res.winner) : "Nobody"} wins`;
}

/** Counts this match toward career score / stats once the result is confirmed. */
function useRecordMatch(coord: Coordinator, res: MatchResult | null, committed: boolean) {
  useEffect(() => {
    if (!res || !(committed || res.reason === "no-contest")) return;
    const mine = res.rankings.find((r) => r.playerId === coord.playerId);
    if (!mine) return;
    recordGame({
      id: res.matchId,
      score: mine.score,
      kos: mine.kos,
      attackSent: mine.attackSent,
      won: wonResult(res, coord.playerId),
      players: res.rankings.length,
      team: res.winnerTeam !== null,
    });
  }, [res, committed, coord]);
}

function RoundTable({ st, res, me }: { st: RoomState; res: MatchResult; me: string }) {
  const teams = res.rankings.some((r) => r.team);
  return (
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Player</th>
          <th>KOs</th>
          <th>Sent</th>
          <th className="hide-sm">Lines</th>
          <th className="hide-sm">Score</th>
          <th>Pts</th>
        </tr>
      </thead>
      <tbody>
        {res.rankings.map((r) => (
          <tr key={r.playerId} className={`${r.playerId === me ? "me" : ""} ${teams ? "team-row" : ""}`} style={teams ? teamRow(r.team) : undefined}>
            <td>{r.placement === 1 ? (teams ? "✓" : "🏆") : r.placement}</td>
            <td>
              {teams && <TeamDot team={r.team} />} {avatarOf(st, r.playerId)} {nameOf(st, r.playerId)}
            </td>
            <td>{r.kos}</td>
            <td>{r.attackSent}</td>
            <td className="hide-sm">{r.lines}</td>
            <td className="hide-sm">{r.score.toLocaleString()}</td>
            <td className="pts">+{r.points}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Teams that stayed the same all series (so team colours mean something across rounds). */
const fixedTeams = (sr: Series) => sr.teams && !sr.mixed;

function TeamScore({ sr }: { sr: Series }) {
  // Redrawn every round: a colour's tally isn't anyone's score.
  if (!sr.teams || sr.mixed) return null;
  const [a, b] = sr.teamWins;
  return (
    <div className="team-score" aria-label={`${TEAM_INFO[1].name} ${a}, ${TEAM_INFO[2].name} ${b}`}>
      <TeamBadge team={1} label="name" className="big" />
      <b>
        {a} – {b}
      </b>
      <TeamBadge team={2} label="name" className="big" />
    </div>
  );
}

/** Overall standings with each player's movement since the previous round. */
function Standings({ st, sr, me, showMove }: { st: RoomState; sr: Series; me: string; showMove: boolean }) {
  const last = sr.rounds.at(-1);
  const prev = new Map(
    [...sr.standings]
      .map((s, i) => ({ s, i, before: s.points - (last?.by[s.playerId]?.[1] ?? 0) }))
      .sort((a, b) => b.before - a.before || a.i - b.i)
      .map((x, rank) => [x.s.playerId, rank]),
  );
  return (
    <ol className="standings">
      {sr.standings.map((s, i) => {
        const move = showMove && last ? (prev.get(s.playerId) ?? i) - i : 0;
        return (
          <li key={s.playerId} className={`${s.playerId === me ? "me" : ""} ${fixedTeams(sr) ? "team-row" : ""}`} style={fixedTeams(sr) ? teamRow(s.team) : undefined}>
            <span className="rank">{medal(i + 1)}</span>
            {fixedTeams(sr) && <TeamDot team={s.team} />}
            <span className="avatar">{avatarOf(st, s.playerId)}</span>
            <span className="name">{s.name}</span>
            {move !== 0 && <span className={`move ${move > 0 ? "up" : "down"}`}>{move > 0 ? `▲${move}` : `▼${-move}`}</span>}
            <span className="muted small hide-sm">{s.wins}W · {s.kos} KO</span>
            <b className="pts">{s.points}</b>
          </li>
        );
      })}
    </ol>
  );
}

/** Between rounds: this round's ranking, the overall table, and the countdown to the next round. */
export function RoundResults({ coord, st }: { coord: Coordinator; st: RoomState }) {
  const v = coord.view();
  const res = st.lastResult;
  const sr = st.series!;
  const me = coord.playerId;
  useRecordMatch(coord, res, v.matchEndCommitted);
  const next = coord.canNextRound();
  const secs = v.nextRoundInMs === null ? null : Math.ceil(v.nextRoundInMs / 1000);
  return (
    <div className="results-layout">
      <div className={`panel results ${res && wonResult(res, me) ? "won" : ""}`}>
        <div className="round-label">
          Round {res?.round ?? sr.played} of {sr.total}
        </div>
        <h2>{res ? headline(st, res, me) : "Round over"}</h2>
        {!v.matchEndCommitted && <p className="muted small">Confirming result with the room…</p>}
        {res && <RoundTable st={st} res={res} me={me} />}
        <h3>Overall standings</h3>
        <TeamScore sr={sr} />
        <Standings st={st} sr={sr} me={me} showMove />
        <div className="row">
          {secs !== null && <span className="next-round">Round {sr.played + 1} starts in {secs}s</span>}
          {v.isHost && (
            <>
              <button onClick={() => coord.nextRound()} disabled={!next.ok} title={next.reason}>
                Start now
              </button>
              <button className="ghost" onClick={() => confirm("End the series here and go back to the waiting room?") && coord.rematch()}>
                End series
              </button>
            </>
          )}
          {v.isHost && !next.ok && <span className="muted small">{next.reason}</span>}
        </div>
      </div>
      <ChatPanel coord={coord} st={st} title="Room chat" />
    </div>
  );
}

interface Award {
  icon: string;
  title: string;
  who: SeriesStanding;
  detail: string;
}

/** Series awards from the totals. Ties go to the higher overall rank. Zero-value awards are skipped. */
export function seriesAwards(sr: Series): Award[] {
  const by = (pick: (s: SeriesStanding) => number) => {
    let best: SeriesStanding | null = null;
    for (const s of sr.standings) if (pick(s) > 0 && (!best || pick(s) > pick(best))) best = s;
    return best;
  };
  const out: Award[] = [];
  const champ = sr.standings[0];
  if (champ) out.push({ icon: "🏆", title: "Champion", who: champ, detail: `${champ.points} points` });
  const wt = seriesWinnerTeam(sr);
  if (sr.teams && wt) {
    const mvp = sr.standings.find((s) => s.team === wt);
    if (mvp) out.push({ icon: "⭐", title: "MVP", who: mvp, detail: `top scorer for ${TEAM_INFO[wt].name}` });
  }
  const add = (icon: string, title: string, pick: (s: SeriesStanding) => number, unit: string) => {
    const w = by(pick);
    if (w) out.push({ icon, title, who: w, detail: `${pick(w).toLocaleString()} ${unit}` });
  };
  add("🥊", "Knockout king", (s) => s.kos, "KOs");
  add("🎯", "Artillery", (s) => s.attackSent, "lines sent");
  add("🧱", "Line machine", (s) => s.lines, "lines cleared");
  add("💎", "High roller", (s) => s.bestScore, "in one round");
  if (!fixedTeams(sr) && sr.total > 1) add("🛡️", "Survivor", (s) => s.wins, "round wins");
  return out;
}

/** After the last round: champion, podium, full table, awards and the achievements you unlocked. */
export function SeriesResults({ coord, st, unlocks }: { coord: Coordinator; st: RoomState; unlocks: Achievement[] }) {
  const v = coord.view();
  const res = st.lastResult;
  const sr = st.series!;
  const me = coord.playerId;
  useRecordMatch(coord, res, v.matchEndCommitted);
  const wt = seriesWinnerTeam(sr);
  const top = sr.standings[0];
  // Fixed teams are ranked by team; redrawn ("mixed") teams by person.
  const byTeam = sr.teams && !sr.mixed;
  const iWon = byTeam ? wt !== null && sr.standings.find((s) => s.playerId === me)?.team === wt : top?.playerId === me;
  const mvp = byTeam && wt !== null && sr.standings.find((s) => s.team === wt)?.playerId === me;
  useEffect(() => {
    if (!v.matchEndCommitted || sr.total < 2 || !sr.standings.some((s) => s.playerId === me)) return;
    recordSeries({ id: sr.id, won: iWon, mvp });
  }, [v.matchEndCommitted, sr, me, iWon, mvp]);

  const awards = seriesAwards(sr);
  const multi = sr.total > 1;
  const title = byTeam
    ? wt
      ? `${TEAM_INFO[wt].name} wins${multi ? " the series" : ""}!`
      : "It's a draw!"
    : top
      ? top.playerId === me
        ? multi
          ? "You win the series!"
          : "Victory!"
        : `${top.name} wins${multi ? " the series" : ""}!`
      : "Game over";
  const podium = sr.standings.slice(0, 3);
  return (
    <div className="results-layout">
      <div className={`panel results final ${iWon ? "won" : ""}`}>
        <div className="round-label">{multi ? `Final — ${sr.played} of ${sr.total} rounds` : res && res.reason === "no-contest" ? "No result" : "Final"}</div>
        <h2>{title}</h2>
        {!v.matchEndCommitted && <p className="muted small">Confirming result with the room…</p>}
        <TeamScore sr={sr} />
        {podium.length > 1 && (
          <div className="podium" aria-label="Podium">
            {[podium[1], podium[0], podium[2]].map((s, i) =>
              s ? (
                <div key={s.playerId} className={`podium-step p${i === 1 ? 1 : i === 0 ? 2 : 3} ${s.playerId === me ? "me" : ""}`}>
                  <span className="avatar big-avatar">{avatarOf(st, s.playerId)}</span>
                  <b>{s.name}</b>
                  <span className="muted small">{s.points} pts</span>
                  <div className="step">{i === 1 ? 1 : i === 0 ? 2 : 3}</div>
                </div>
              ) : (
                <div key={`none${i}`} />
              ),
            )}
          </div>
        )}
        <h3>Overall ranking</h3>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Pts</th>
              {multi && <th>Wins</th>}
              <th>KOs</th>
              <th className="hide-sm">Sent</th>
              <th className="hide-sm">Lines</th>
              <th className="hide-sm">Best</th>
            </tr>
          </thead>
          <tbody>
            {sr.standings.map((s, i) => (
              <tr key={s.playerId} className={`${s.playerId === me ? "me" : ""} ${byTeam ? "team-row" : ""}`} style={byTeam ? teamRow(s.team) : undefined}>
                <td>{medal(i + 1)}</td>
                <td>
                  {fixedTeams(sr) && <TeamDot team={s.team} />} {avatarOf(st, s.playerId)} {s.name}
                </td>
                <td className="pts">{s.points}</td>
                {multi && <td>{s.wins}</td>}
                <td>{s.kos}</td>
                <td className="hide-sm">{s.attackSent}</td>
                <td className="hide-sm">{s.lines}</td>
                <td className="hide-sm">{s.bestScore.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {multi && (
          <>
            <h3>Round by round</h3>
            <div className="round-grid-wrap">
              <table className="round-grid">
                <thead>
                  <tr>
                    <th>Player</th>
                    {sr.rounds.map((r, i) => (
                      <th key={r.matchId} title={r.winnerTeam ? `${TEAM_INFO[r.winnerTeam].name} won` : r.winner ? `${nameOf(st, r.winner)} won` : "No result"}>
                        R{i + 1}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sr.standings.map((s) => (
                    <tr key={s.playerId} className={s.playerId === me ? "me" : ""}>
                      <td>{s.name}</td>
                      {sr.rounds.map((r) => {
                        const x = r.by[s.playerId];
                        return (
                          <td key={r.matchId} className={x?.[0] === 1 && r.reason === "knockout" ? "round-win" : ""}>
                            {x ? x[1] : "–"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {awards.length > 0 && (
          <>
            <h3>Awards</h3>
            <ul className="awards">
              {awards.map((a) => (
                <li key={a.title} className={a.who.playerId === me ? "me" : ""}>
                  <span className="award-icon">{a.icon}</span>
                  <span>
                    <b>{a.title}</b>
                    <span className="small">
                      {a.who.name} · {a.detail}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <h3>Your achievements</h3>
        {unlocks.length ? (
          <ul className="awards">
            {unlocks.map((a) => (
              <li key={a.id} className="me">
                <span className="award-icon">{a.icon}</span>
                <span>
                  <b>{a.name}</b>
                  <span className="small">{a.desc}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No new achievements this time — check Trophies for what's left to unlock.</p>
        )}
        <div className="row">
          {v.isHost ? (
            <button onClick={() => coord.rematch()}>Back to waiting room</button>
          ) : (
            <span className="muted">Waiting for the host to head back to the waiting room…</span>
          )}
        </div>
      </div>
      <ChatPanel coord={coord} st={st} title="Room chat" />
    </div>
  );
}

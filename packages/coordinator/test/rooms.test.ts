import { describe, expect, it } from "vitest";
import { deserializeState, drawTeams, roundPoints, serializeState, seriesWinnerTeam, stateHash, type CoordinatorEvent } from "@tk/coordinator";
import { Cluster } from "./harness.js";

const weak = (names: string[], skill = 0.25) => Object.fromEntries(names.map((n) => [n, skill]));

function effects(evts: CoordinatorEvent[], kind: string) {
  return evts.flatMap((e) => (e.kind === "effect" && e.effect.kind === kind ? [e.effect] : []));
}

describe("teams (up to 5 v 5)", () => {
  it("balances teams on join, never attacks a teammate, and ends when one side is out", () => {
    const names = ["ana", "ben", "cai", "dee"];
    const c = new Cluster();
    c.lobby(names, weak(names));
    const ana = c.get("ana").coord;
    expect(ana.view().state!.roster.map((r) => r.team)).toEqual([1, 2, 1, 2]);
    expect(ana.setOptions({ teams: true })).toBe(true);
    c.run(300);
    c.startMatch("ana");
    const st = () => ana.view().state!;
    const m = st().match!;
    expect(m.teams).not.toBeNull();
    const teamOf = (pid: string) => m.teams![pid];

    // Manual targeting of a teammate is refused by the state machine.
    const teammate = m.participants.find((p) => p !== c.get("ana").pid && teamOf(p) === teamOf(c.get("ana").pid))!;
    ana.setTarget("manual", teammate);
    c.run(200);
    expect(st().match!.players[c.get("ana").pid]!.manualTarget).toBeNull();

    c.runUntil(() => st().phase === "ended", 240_000);
    c.settle();
    expect(c.consistent()).toBe(true);
    const res = st().lastResult!;
    expect(res.reason).toBe("knockout");
    expect(res.winnerTeam === 1 || res.winnerTeam === 2).toBe(true);
    for (const r of res.rankings) if (r.placement === 1) expect(r.team).toBe(res.winnerTeam);
    for (const n of c.alive()) {
      for (const a of effects(n.events, "attack") as { from: string; to: string }[]) expect(teamOf(a.from)).not.toBe(teamOf(a.to));
      for (const k of effects(n.events, "ko") as { victim: string; by: string | null }[]) if (k.by) expect(teamOf(k.by)).not.toBe(teamOf(k.victim));
    }
  });

  it("caps a team at five and needs both sides to start", () => {
    const names = ["ana", "ben", "cai", "dee", "eli", "fay", "gus", "hal", "ivy", "jon"];
    const c = new Cluster();
    c.lobby(names);
    const ana = c.get("ana").coord;
    ana.setOptions({ teams: true });
    c.run(300);
    const st = () => ana.view().state!;
    expect(st().roster.filter((r) => r.team === 1)).toHaveLength(5);
    // Full side: switching is refused locally and by the host.
    expect(c.get("ben").coord.setTeam(1)).toBe(false);
    expect(ana.setTeam(1, c.get("ben").pid)).toBe(false);
    // Swap two players and the counts stay 5/5 at every step.
    expect(ana.setTeam(2)).toBe(false);
    c.get("ben").coord.setReady(false);
    c.run(300);
    c.closeTab("jon", true);
    c.runUntil(() => c.alive().every((n) => n.coord.view().state!.roster.length === 9), 10_000);
    expect(c.get("ben").coord.setTeam(1)).toBe(false); // team 1 still has 5
    expect(c.get("cai").coord.setTeam(2)).toBe(true);
    c.run(300);
    expect(st().roster.filter((r) => r.team === 2)).toHaveLength(5);
    c.settle();
    expect(c.consistent()).toBe(true);

    // Everyone on one side: can't start.
    const solo = new Cluster();
    solo.lobby(["ana", "ben"]);
    const host = solo.get("ana").coord;
    host.setOptions({ teams: true });
    host.setTeam(1, solo.get("ben").pid);
    solo.run(300);
    solo.get("ben").coord.setReady(true);
    solo.run(300);
    expect(host.canStart()).toMatchObject({ ok: false, reason: "Both teams need at least one player" });
    expect(host.startMatch()).toBe(false);
    host.balanceTeams();
    solo.run(300);
    expect(host.canStart().ok).toBe(true);
  });
});

describe("random teams", () => {
  it("draws even, deterministic teams", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `${i}`.padStart(16, "a"));
    for (const n of [2, 3, 7, 10]) {
      for (const seed of [1, 99, 123456]) {
        const t = drawTeams(ids.slice(0, n), seed);
        const ones = Object.values(t).filter((x) => x === 1).length;
        expect(Math.abs(ones - (n - ones))).toBeLessThanOrEqual(1);
        expect(drawTeams(ids.slice(0, n), seed)).toEqual(t);
      }
    }
    // Different seeds give different line-ups (at least sometimes).
    const draws = new Set(Array.from({ length: 20 }, (_, s) => JSON.stringify(drawTeams(ids, s + 1))));
    expect(draws.size).toBeGreaterThan(5);
  });

  it("'random' draws once per series; 'round' redraws every round", () => {
    const names = ["ana", "ben", "cai", "dee", "eli", "fay"];
    const c = new Cluster({ intermissionMs: 800 });
    c.lobby(names, weak(names));
    const ana = c.get("ana").coord;
    const st = () => ana.view().state!;
    expect(ana.setOptions({ teams: true, teamPick: "random", rounds: 2 })).toBe(true);
    c.run(300);
    // Players can't pick their own side in a random room.
    expect(c.get("ben").coord.setTeam(c.get("ben").coord.teamOf(c.get("ben").pid) === 1 ? 2 : 1)).toBe(false);
    c.startMatch("ana");
    const first = { ...st().match!.teams! };
    expect(Object.values(first).filter((t) => t === 1)).toHaveLength(3);
    // The draw is mirrored into the roster, identically on every peer.
    for (const n of c.alive()) for (const r of n.coord.view().state!.roster) expect(r.team).toBe(first[r.playerId]);
    c.runUntil(() => st().phase === "ended", 240_000);
    c.runUntil(() => st().match?.round === 2 && st().phase !== "ended", 20_000);
    expect(st().match!.teams).toEqual(first); // kept for the whole series
    c.runUntil(() => st().series!.done, 240_000);
    expect(st().series!.mixed).toBe(false);

    // Every round: each round is drawn fresh from its own seed.
    ana.rematch();
    c.run(300);
    expect(ana.setOptions({ teamPick: "round", rounds: 3 })).toBe(true);
    for (const n of names.slice(1)) c.get(n).coord.setReady(true);
    c.runUntil(() => ana.canStart().ok, 5000);
    c.startMatch("ana");
    const lineups: string[] = [];
    for (let round = 1; round <= 3; round++) {
      c.runUntil(() => st().match?.round === round && st().phase !== "ended", 30_000);
      const t = st().match!.teams!;
      expect(Object.values(t).filter((x) => x === 1)).toHaveLength(3);
      lineups.push(JSON.stringify(t));
      c.runUntil(() => st().phase === "ended", 240_000);
    }
    expect(st().series).toMatchObject({ mixed: true, done: true });
    // Redrawn teams: the series is ranked by person, not by colour.
    expect(seriesWinnerTeam(st().series!)).toBeNull();
    c.settle();
    expect(c.consistent()).toBe(true);
  });
});

describe("series of rounds", () => {
  it("plays the host's number of rounds back to back and totals the points", () => {
    const names = ["ana", "ben", "cai"];
    const c = new Cluster({ intermissionMs: 1500 });
    c.lobby(names, weak(names));
    const ana = c.get("ana").coord;
    ana.setOptions({ rounds: 3 });
    c.run(300);
    c.startMatch("ana");
    const st = () => ana.view().state!;
    expect(st().series).toMatchObject({ total: 3, played: 0, done: false });
    expect(st().match!.round).toBe(1);

    c.runUntil(() => st().phase === "ended", 240_000);
    expect(st().series!.played).toBe(1);
    expect(st().lastResult!.round).toBe(1);
    // The next round starts by itself after the intermission, without readying up.
    c.runUntil(() => st().phase === "countdown" || st().phase === "playing", 10_000);
    expect(st().match!.round).toBe(2);
    c.runUntil(() => st().series!.done, 480_000);
    c.settle();
    expect(c.consistent()).toBe(true);

    const sr = st().series!;
    expect(sr.played).toBe(3);
    expect(sr.rounds).toHaveLength(3);
    for (const s of sr.standings) {
      const sum = sr.rounds.reduce((a, r) => a + (r.by[s.playerId]?.[1] ?? 0), 0);
      expect(s.points).toBe(sum);
      expect(s.roundsPlayed).toBe(3);
    }
    expect(sr.standings.reduce((a, s) => a + s.wins, 0)).toBe(sr.rounds.filter((r) => r.reason === "knockout").length);
    // Sorted best first.
    for (let i = 1; i < sr.standings.length; i++) expect(sr.standings[i - 1]!.points).toBeGreaterThanOrEqual(sr.standings[i]!.points);
    for (const n of c.alive()) expect(n.events.some((e) => e.kind === "effect" && e.effect.kind === "series-end")).toBe(true);
    // Snapshots with a series and results survive the wire bit-for-bit (the state hash is over JSON).
    expect(stateHash(deserializeState(JSON.parse(JSON.stringify(serializeState(st())))))).toBe(stateHash(st()));
    // No more rounds once it's over.
    c.run(3000);
    expect(st().phase).toBe("ended");
    expect(ana.nextRound()).toBe(false);
    // Back to the waiting room, then a fresh series.
    expect(ana.rematch()).toBe(true);
    c.run(300);
    expect(st().phase).toBe("lobby");
  });

  it("going back to the waiting room mid-series ends it early", () => {
    const names = ["ana", "ben"];
    const c = new Cluster({ intermissionMs: 60_000 });
    c.lobby(names, weak(names));
    const ana = c.get("ana").coord;
    ana.setOptions({ rounds: 5 });
    c.run(300);
    c.startMatch("ana");
    const st = () => ana.view().state!;
    c.runUntil(() => st().phase === "ended", 240_000);
    c.settle(500);
    expect(c.get("ben").coord.view().nextRoundInMs).toBeGreaterThan(0);
    expect(ana.rematch()).toBe(true);
    c.run(300);
    expect(st().series).toMatchObject({ played: 1, done: true, endedEarly: true });
    expect(c.get("ben").coord.view().nextRoundInMs).toBeNull();
    c.settle();
    expect(c.consistent()).toBe(true);
  });

  it("round points", () => {
    // Free-for-all, 4 players: 1 per player outlasted, +2 for the win, +1 per KO.
    expect(roundPoints({ placement: 1, kos: 2, team: 0 }, 4, null, false, "knockout")).toBe(3 + 2 + 2);
    expect(roundPoints({ placement: 4, kos: 0, team: 0 }, 4, null, false, "knockout")).toBe(0);
    // Teams: +3 team win, +1 still standing, +1 per KO.
    expect(roundPoints({ placement: 1, kos: 1, team: 2 }, 6, 2, true, "knockout")).toBe(5);
    expect(roundPoints({ placement: 3, kos: 1, team: 2 }, 6, 2, true, "knockout")).toBe(4);
    expect(roundPoints({ placement: 2, kos: 0, team: 1 }, 6, 2, true, "knockout")).toBe(0);
    expect(roundPoints({ placement: 1, kos: 3, team: 0 }, 4, null, false, "no-contest")).toBe(0);
  });
});

describe("room chat", () => {
  it("delivers room and team messages, throttles bursts, and gives newcomers recent history", () => {
    const c = new Cluster();
    c.lobby(["ana", "ben", "cai"]);
    const ana = c.get("ana").coord, ben = c.get("ben").coord, cai = c.get("cai").coord;
    const texts = (co: typeof ana) => co.chatMessages().map((m) => m.text);

    expect(ana.sendChat("  hello\u0007   world  ")).toBe(true);
    c.run(200);
    for (const co of [ana, ben, cai]) expect(texts(co)).toEqual(["hello world"]);
    expect(ben.chatMessages()[0]).toMatchObject({ from: c.get("ana").pid, name: "ana", team: false });
    expect(ana.sendChat("   ")).toBe(false);

    // Team chat only exists in a team room; ana (1) and cai (1) vs ben (2).
    ana.setOptions({ teams: true });
    c.run(300);
    expect(ana.sendChat("psst", true)).toBe(true);
    c.run(200);
    expect(texts(cai)).toContain("psst");
    expect(texts(ben)).not.toContain("psst");

    // Burst limit.
    let sent = 0;
    for (let i = 0; i < 10; i++) {
      c.run(300);
      if (ben.sendChat(`spam ${i}`)) sent++;
    }
    expect(sent).toBeLessThan(10);

    // A newcomer gets the recent public messages (not team ones).
    const dee = c.add("dee");
    c.runUntil(() => texts(dee.coord).length > 0, 10_000);
    expect(texts(dee.coord)[0]).toBe("hello world");
    expect(texts(dee.coord)).not.toContain("psst");
    const longMsg = "x".repeat(500);
    c.run(5000);
    expect(dee.coord.sendChat(longMsg)).toBe(true);
    c.run(200);
    expect(texts(ana).at(-1)).toHaveLength(200);
  });
});

describe("kick", () => {
  it("removes a player, who can't rejoin; mid-match it counts as a forfeit", () => {
    const names = ["ana", "ben", "cai"];
    const c = new Cluster();
    c.lobby(names);
    const ana = c.get("ana").coord;
    const ben = c.get("ben");
    expect(c.get("cai").coord.kick(ben.pid)).toBe(false); // only the host
    expect(ana.kick(c.get("ana").pid)).toBe(false); // not yourself
    c.startMatch("ana");
    expect(ana.kick(ben.pid)).toBe(true);
    c.runUntil(() => ben.coord.view().mode === "rejected", 5000);
    expect(ben.coord.view().rejectedReason).toBe("kicked");
    const st = ana.view().state!;
    expect(st.roster.map((r) => r.name)).toEqual(["ana", "cai"]);
    expect(st.match!.players[ben.pid]!.alive).toBe(false);
    expect(st.kicked).toContain(ben.pid);

    c.closeTab("ben", false);
    const again = c.rejoin("ben");
    c.runUntil(() => again.coord.view().mode === "rejected", 10_000);
    expect(again.coord.view().rejectedReason).toBe("kicked");
    c.closeTab("ben", false);
    c.settle();
    expect(c.consistent()).toBe(true);
    expect(stateHash(c.get("cai").coord.view().state!)).toBe(stateHash(ana.view().state!));
  });
});

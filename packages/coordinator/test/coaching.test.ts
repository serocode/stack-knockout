import { describe, expect, it } from "vitest";
import { hardDropY, spawnPos } from "@tk/engine";
import { Cluster } from "./harness.js";

/** ana and ben keep playing; cai (a hopeless bot) gets knocked out and coaches. */
function withKnockedOutCoach(): Cluster {
  const c = new Cluster();
  c.lobby(["ana", "ben", "cai"], { cai: 0 });
  c.startMatch("ana");
  const caiPid = c.get("cai").pid;
  c.runUntil(() => c.alive().every((n) => n.coord.view().state!.match!.players[caiPid]!.alive === false), 120_000);
  // Freeze ana so her current piece stays put while we coach her.
  c.get("ana").bot = false;
  c.settle();
  return c;
}

describe("coaching", () => {
  it("a knocked-out player's suggestion reaches the coached player and everyone else", () => {
    const c = withKnockedOutCoach();
    const ana = c.get("ana");
    const cai = c.get("cai");
    const mp = cai.coord.view().state!.match!.players[ana.pid]!;
    const start = spawnPos(mp.sim.s.active);
    const piece = { ...start, y: hardDropY(mp.sim.s.board, start) };

    expect(cai.coord.canCoach(ana.pid)).toBe(true);
    expect(cai.coord.suggestPlacement(ana.pid, { idx: mp.sim.s.piecesPlaced, usedHold: false, piece })).toBe(true);
    c.run(300);

    const got = ana.coord.suggestionsFor(ana.pid);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ from: cai.pid, to: ana.pid, piece, usedHold: false });
    expect(ana.events.some((e) => e.kind === "suggestion" && e.suggestion.from === cai.pid)).toBe(true);
    // Other room members see it too, so coaches can build on each other.
    expect(c.get("ben").coord.suggestionsFor(ana.pid)).toHaveLength(1);

    ana.coord.tookSuggestion(cai.pid);
    c.run(300);
    expect(cai.events.some((e) => e.kind === "suggestion-taken" && e.player === ana.pid && e.coach === cai.pid)).toBe(true);
  });

  it("a suggestion expires once the coached player locks that piece", () => {
    const c = withKnockedOutCoach();
    const ana = c.get("ana");
    const cai = c.get("cai");
    const mp = cai.coord.view().state!.match!.players[ana.pid]!;
    const start = spawnPos(mp.sim.s.active);
    cai.coord.suggestPlacement(ana.pid, { idx: mp.sim.s.piecesPlaced, usedHold: false, piece: { ...start, y: hardDropY(mp.sim.s.board, start) } });
    c.run(300);
    expect(ana.coord.suggestionsFor(ana.pid)).toHaveLength(1);
    ana.bot = true;
    c.run(1000);
    expect(ana.coord.suggestionsFor(ana.pid)).toHaveLength(0);
  });

  it("players still in the match cannot coach, and nobody can coach a knocked-out player", () => {
    const c = withKnockedOutCoach();
    const ana = c.get("ana");
    const ben = c.get("ben");
    const cai = c.get("cai");
    const mp = ben.coord.view().state!.match!.players[ana.pid]!;
    const start = spawnPos(mp.sim.s.active);
    expect(ben.coord.canCoach(ana.pid)).toBe(false);
    expect(ben.coord.suggestPlacement(ana.pid, { idx: mp.sim.s.piecesPlaced, usedHold: false, piece: start })).toBe(false);
    expect(ana.coord.canCoach(cai.pid, ben.pid)).toBe(false);
    expect(cai.coord.canCoach(cai.pid)).toBe(false);
    c.run(300);
    expect(ana.coord.suggestionsFor(ana.pid)).toHaveLength(0);
  });

  it("callouts reach every peer and are throttled", () => {
    const c = new Cluster();
    c.lobby(["ana", "ben", "cai"]);
    c.startMatch("ana");
    const ana = c.get("ana");
    expect(ana.coord.sendCallout("focus", c.get("cai").pid)).toBe(true);
    expect(ana.coord.sendCallout("nice")).toBe(false); // too soon
    expect(ana.coord.sendCallout("Bad Code!")).toBe(false);
    expect(ana.coord.sendCallout("nice", "not-a-player")).toBe(false);
    c.run(300);
    for (const n of ["ben", "cai"]) {
      const calls = c.get(n).events.filter((e) => e.kind === "callout");
      expect(calls).toEqual([{ kind: "callout", from: ana.pid, code: "focus", about: c.get("cai").pid }]);
    }
    c.run(1000);
    expect(ana.coord.sendCallout("nice")).toBe(true);
  });
});

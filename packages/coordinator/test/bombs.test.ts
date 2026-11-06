import { describe, expect, it } from "vitest";
import { BOMB_CELL } from "@tk/engine";
import { bombRowsFor } from "../src/state.js";
import { Cluster } from "./harness.js";

describe("bomb garbage rules", () => {
  it("bomb row patterns", () => {
    expect(bombRowsFor("off", 4)).toEqual([]);
    expect(bombRowsFor("sparse", 4)).toEqual([0]);
    expect(bombRowsFor("half", 5)).toEqual([0, 2, 4]);
    expect(bombRowsFor("every", 3)).toEqual([0, 1, 2]);
  });

  it("host-set options replicate, lock at start, and bomb garbage stays consistent", () => {
    const c = new Cluster();
    c.lobby(["ana", "ben", "cai"], { ana: 0.97, ben: 0.97, cai: 0.97 });
    const opts = { bombs: "every", blast: "line", bombBonus: 2 } as const;
    expect(c.get("ben").coord.setOptions(opts)).toBe(false); // not the host
    expect(c.get("ana").coord.setOptions(opts)).toBe(true);
    c.run(300);
    for (const n of c.alive()) expect(n.coord.view().state!.options).toEqual(opts);

    c.startMatch("ana");
    expect(c.get("ana").coord.setOptions({ ...opts, bombs: "off" })).toBe(false); // locked mid-match
    for (const n of c.alive()) {
      const m = n.coord.view().state!.match!;
      expect(m.options).toEqual(opts);
      for (const pid of m.participants) expect(m.players[pid]!.sim.s.bombs).toEqual({ blast: "line", bonus: 2 });
    }

    // Play until some board actually holds a bomb.
    c.runUntil(() => {
      const m = c.get("ana").coord.view().state!.match;
      return !!m && m.participants.some((p) => m.players[p]!.sim.s.board.includes(BOMB_CELL));
    }, 120_000);
    const m = c.get("ana").coord.view().state!.match!;
    for (const pid of m.participants)
      for (const g of m.players[pid]!.commanded) {
        expect(g.bombCol).not.toBe(g.holeCol);
        expect(g.bombRows).toEqual(bombRowsFor("every", g.lines));
      }
    c.settle();
    expect(c.consistent()).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { botPlacement, spawnPos } from "@tk/engine";
import { Cluster } from "./harness.js";

/** ben hosts; ana and cai are regular players. Bots off so we control every move. 25 ms one-way latency. */
function match(): Cluster {
  const c = new Cluster({}, 25);
  c.lobby(["ben", "ana", "cai"]);
  c.startMatch("ben");
  for (const n of c.nodes.values()) n.bot = false;
  c.settle(500);
  return c;
}

const placedOf = (c: Cluster, observer: string, player: string) => c.get(observer).coord.view().state!.match!.players[c.get(player).pid]!.sim.s.piecesPlaced;

describe("latency", () => {
  it("a lock shows on other players' screens after one hop, before the host's log entry", () => {
    const c = match();
    const ana = c.get("ana");
    const before = placedOf(c, "cai", "ana");
    const pl = botPlacement(ana.coord.view().localSim!, 1, 1).placement!;
    ana.coord.submitPlacement(pl);
    c.run(30, 5); // one hop, not two
    const lock = c.get("cai").coord.remoteLocks.get(ana.pid);
    expect(lock).toMatchObject({ idx: before, piece: { type: pl.type, x: pl.x, y: pl.y, rot: pl.rot } });
    expect(placedOf(c, "cai", "ana")).toBe(before); // the log hasn't caught up yet
    c.run(100, 5);
    expect(placedOf(c, "cai", "ana")).toBe(before + 1);
  });

  it("falling-piece updates go out right away at up to 20 Hz, with the final position always sent", () => {
    const c = match();
    const ana = c.get("ana");
    const cai = c.get("cai").coord;
    const start = spawnPos(ana.coord.view().localSim!.s.active);
    ana.coord.publishLivePiece(start);
    c.run(30, 5);
    expect(cai.remotePieces.get(ana.pid)?.piece).toEqual(start);
    // Two quick moves: the second is held back by the 50 ms limit, then sent.
    ana.coord.publishLivePiece({ ...start, x: start.x + 1 });
    ana.coord.publishLivePiece({ ...start, x: start.x + 2 });
    c.run(30, 5);
    expect(cai.remotePieces.get(ana.pid)?.piece.x).toBe(start.x);
    c.run(50, 5);
    expect(cai.remotePieces.get(ana.pid)?.piece.x).toBe(start.x + 2);
  });

  it("ignores a stale falling-piece packet that arrives late (the live channel is unordered)", () => {
    const c = match();
    const ana = c.get("ana");
    const cai = c.get("cai").coord;
    const sim = ana.coord.view().localSim!;
    const start = spawnPos(sim.s.active);
    for (let i = 1; i <= 3; i++) {
      ana.coord.publishLivePiece({ ...start, x: start.x + i });
      c.run(60, 5);
    }
    expect(cai.remotePieces.get(ana.pid)?.piece.x).toBe(start.x + 3);
    // An old packet (sequence 1) shows up after the newer ones.
    const mid = ana.coord.view().state!.match!.matchId;
    ana.mesh.send("live", "live", { mid, i: sim.s.piecesPlaced, q: 1, p: { t: start.type, x: start.x, y: start.y, r: start.rot } });
    c.run(60, 5);
    expect(cai.remotePieces.get(ana.pid)?.piece.x).toBe(start.x + 3);
  });
});

import { describe, expect, it } from "vitest";
import { stateHash } from "@tk/coordinator";
import { Cluster } from "./harness.js";

const SIX = ["ana", "ben", "cai", "dee", "eli", "fay"];

function piecesOf(c: Cluster, observer: string, player: string): number {
  return c.get(observer).coord.view().state!.match!.players[c.get(player).pid]!.sim.s.piecesPlaced;
}

describe("rooms and lobby", () => {
  it("1. two players establish a match", () => {
    const c = new Cluster();
    c.lobby(["ana", "ben"]);
    c.startMatch("ana");
    c.run(5000);
    c.settle();
    expect(c.consistent()).toBe(true);
    expect(piecesOf(c, "ben", "ana")).toBeGreaterThan(5);
    expect(piecesOf(c, "ana", "ben")).toBeGreaterThan(5);
  });

  it("2/3. six players join and a seventh is rejected", () => {
    const c = new Cluster();
    c.lobby(SIX);
    expect(c.get("ana").coord.view().state!.roster.map((r) => r.name)).toEqual(SIX);
    const gus = c.add("gus");
    c.runUntil(() => gus.coord.view().mode === "rejected");
    expect(gus.coord.view().rejectedReason).toBe("full");
    c.settle();
    expect(c.get("ana").coord.view().state!.roster).toHaveLength(6);
  });

  it("17. different cosmetics coexist and never affect simulation", () => {
    const c = new Cluster();
    c.lobby(["ana", "ben", "cai"]);
    c.get("ana").coord.setCosmetics({ block: "neon", frame: "cyberpunk" });
    c.get("ben").coord.setCosmetics({ block: "pixel", frame: "ice", effect: "shatter" });
    c.settle();
    const roster = c.get("cai").coord.view().state!.roster;
    expect(roster.find((r) => r.name === "ana")!.cosmetics.block).toBe("neon");
    expect(roster.find((r) => r.name === "ben")!.cosmetics.frame).toBe("ice");
    c.startMatch("ana");
    c.run(3000);
    c.settle();
    expect(c.consistent()).toBe(true);
  });
});

describe("creator comes back", () => {
  it("a lone creator who reloads becomes host again instead of waiting forever", () => {
    const c = new Cluster();
    c.add("ana", { create: true });
    c.run(500);
    c.closeTab("ana", false);
    const ana = c.rejoin("ana", { hostIfAloneAfterMs: 5000 });
    c.runUntil(() => ana.coord.view().mode === "host", 10_000);
    const ben = c.add("ben");
    c.runUntil(() => ben.coord.view().mode === "follower", 10_000);
    expect(ana.coord.view().state!.roster.map((r) => r.name)).toEqual(["ana", "ben"]);
  });

  it("2-player lobby: creator reloads, the friend left behind ends up in the recreated room", () => {
    const c = new Cluster();
    c.lobby(["ana", "ben"]);
    c.closeTab("ana", false);
    c.run(3000);
    const ana = c.rejoin("ana", { hostIfAloneAfterMs: 5000 });
    c.runUntil(() => ana.coord.view().mode === "host" && c.get("ben").coord.view().mode === "follower", 20_000);
    c.settle();
    expect(c.consistent()).toBe(true);
    expect(ana.coord.view().state!.roster.map((r) => r.name).sort()).toEqual(["ana", "ben"]);
  });

  it("a creator who reloads while others still have the room rejoins it (no second room)", () => {
    const c = new Cluster();
    c.lobby(["ana", "ben", "cai"]);
    c.startMatch("ana");
    c.run(3000);
    c.closeTab("ana", false);
    c.runUntil(() => c.hosts().length === 1 && c.hosts()[0]!.name === "ben", 15_000);
    const ana = c.rejoin("ana", { hostIfAloneAfterMs: 5000 });
    ana.bot = false;
    c.runUntil(() => ana.coord.view().mode === "follower", 10_000);
    c.run(8000);
    expect(ana.coord.view().mode).toBe("follower");
    expect(c.hosts().map((n) => n.name)).toEqual(["ben"]);
    c.settle();
    expect(c.consistent()).toBe(true);
  });
});

describe("reconnection", () => {
  it("4/5. a player drops temporarily and comes back with their board intact", () => {
    const c = new Cluster();
    c.lobby(["ana", "ben", "cai"]);
    c.startMatch("ana");
    c.run(3000);
    c.goOffline("cai");
    c.runUntil(() => c.get("ana").coord.view().state!.roster.find((r) => r.name === "cai")!.connected === false);
    c.run(2000);
    c.goOnline("cai");
    c.runUntil(() => c.get("ana").coord.view().state!.roster.find((r) => r.name === "cai")!.connected === true);
    c.run(3000);
    c.settle();
    expect(c.consistent()).toBe(true);
    const cai = c.get("cai").coord.view();
    expect(cai.localSim!.hash()).toBe(cai.state!.match!.players[c.get("cai").pid]!.sim.hash());
  });

  it("5b. a player reloads the page and resumes with the same identity and board", () => {
    const c = new Cluster();
    c.lobby(["ana", "ben", "cai"]);
    c.startMatch("ana");
    c.run(3000);
    c.closeTab("cai", false);
    c.runUntil(() => c.get("ana").coord.view().state!.roster.find((r) => r.name === "cai")!.connected === false);
    c.settle(500);
    const before = c.get("ana").coord.view().state!.match!.players[c.get("ana").coord.view().state!.roster.find((r) => r.name === "cai")!.playerId]!.sim.hash();
    const cai = c.rejoin("cai");
    cai.bot = false;
    c.runUntil(() => cai.coord.view().mode === "follower" && cai.coord.view().localSim !== null);
    expect(cai.coord.view().localSim!.hash()).toBe(before);
    cai.bot = true;
    c.run(3000);
    c.settle();
    expect(c.consistent()).toBe(true);
    expect(piecesOf(c, "ana", "cai")).toBeGreaterThan(0);
  });
});

describe("host migration", () => {
  it("6/8/9/13. host closes the tab: deterministic successor, full recovery, play continues", () => {
    const c = new Cluster();
    c.lobby(["ana", "ben", "cai", "dee"]);
    c.startMatch("ana");
    c.run(4000);
    c.settle(300);
    const epochBefore = c.get("ben").coord.view().epoch;
    const benPieces = piecesOf(c, "cai", "ben");
    c.closeTab("ana", true);
    const took = c.runUntil(() => c.hosts().length === 1 && c.alive().every((n) => !n.coord.view().migrating));
    expect(took).toBeLessThan(2000); // graceful leave skips the heartbeat timeout
    expect(c.hosts()[0]!.name).toBe("ben"); // next seat
    c.run(4000);
    c.settle();
    expect(c.consistent()).toBe(true);
    const v = c.get("cai").coord.view();
    expect(v.epoch).toBeGreaterThan(epochBefore);
    expect(v.state!.roster.some((r) => r.name === "ana")).toBe(false); // graceful leave = removed
    expect(v.state!.match!.players[c.get("ben").pid]!.sim.s.piecesPlaced).toBeGreaterThan(benPieces);
    expect(c.get("ben").events.some((e) => e.kind === "host-changed")).toBe(true);
  });

  it("7. host loses connectivity silently; on return it rejoins as a regular player", () => {
    const c = new Cluster();
    c.lobby(["ana", "ben", "cai", "dee"]);
    c.startMatch("ana");
    c.run(4000);
    c.goOffline("ana");
    c.runUntil(() => c.hosts([c.get("ben"), c.get("cai"), c.get("dee")]).length === 1, 15_000);
    // isolated old host must have stepped down (it cannot hear a quorum)
    c.runUntil(() => c.get("ana").coord.view().mode !== "host", 5000);
    expect(c.get("ana").coord.view().paused).toBe(true);
    c.run(3000);
    c.goOnline("ana");
    c.runUntil(() => c.get("ana").coord.view().mode === "follower", 10_000);
    c.run(3000);
    c.settle();
    expect(c.consistent()).toBe(true);
    expect(c.get("ana").coord.view().hostId).toBe(c.get("ben").pid);
    const ana = c.get("ana").coord.view();
    expect(ana.localSim!.hash()).toBe(ana.state!.match!.players[c.get("ana").pid]!.sim.hash());
  });

  it("10. messages from an old host epoch are rejected", () => {
    const c = new Cluster();
    c.lobby(["ana", "ben", "cai"]);
    c.startMatch("ana");
    c.run(2000);
    c.settle(300);
    const oldEpoch = c.get("ana").coord.view().epoch;
    const seq = c.get("ben").coord.view().lastSeq;
    c.goOffline("ana");
    c.runUntil(() => c.get("ben").coord.view().mode === "host", 15_000);
    c.goOnline("ana");
    c.run(200);
    const before = stateHash(c.get("cai").coord.view().state!);
    const rejectedBefore = c.get("cai").coord.stats.staleRejected;
    // A delayed authoritative message from the old host arrives late.
    c.get("ana").mesh.send(
      "crit",
      "log",
      { e: oldEpoch, h: c.get("ana").pid, mid: "x", en: [{ seq: seq + 1, epoch: oldEpoch, k: "end", reason: "no-contest" }], c: seq + 1 },
      c.get("cai").pid,
    );
    c.run(200);
    expect(c.get("cai").coord.stats.staleRejected).toBeGreaterThan(rejectedBefore);
    expect(c.get("cai").coord.view().state!.phase).toBe("playing");
    void before;
  });

  it("11. host and another player drop at the same time (4 of 6 remain)", () => {
    const c = new Cluster();
    c.lobby(SIX);
    c.startMatch("ana");
    c.run(3000);
    c.goOffline("ana");
    c.goOffline("ben");
    const rest = ["cai", "dee", "eli", "fay"].map((n) => c.get(n));
    c.runUntil(() => c.hosts(rest).length === 1 && rest.every((n) => !n.coord.view().paused), 15_000);
    expect(c.hosts(rest)[0]!.name).toBe("cai");
    c.run(4000);
    c.settle();
    expect(c.consistent(rest)).toBe(true);
    expect(piecesOf(c, "dee", "fay")).toBeGreaterThan(10);
  });

  it("12a. even split partition: nobody keeps playing and nobody declares a winner", () => {
    const c = new Cluster({ migrationGiveUpMs: 60_000 });
    c.lobby(SIX);
    c.startMatch("ana");
    c.run(3000);
    c.net.partition([["ana", "ben", "cai"].map((n) => c.get(n).transportId), ["dee", "eli", "fay"].map((n) => c.get(n).transportId)]);
    c.run(8000);
    for (const n of c.alive()) {
      expect(n.coord.view().mode).not.toBe("host");
      expect(n.coord.view().paused).toBe(true);
      expect(n.coord.view().state!.phase).toBe("playing");
    }
    c.net.heal();
    c.runUntil(() => c.hosts().length === 1 && c.alive().every((n) => !n.coord.view().paused), 20_000);
    c.run(3000);
    c.settle();
    expect(c.consistent()).toBe(true);
  });

  it("12b. 4/2 partition with the host in the minority: majority continues, minority catches up", () => {
    const c = new Cluster();
    c.lobby(SIX);
    c.startMatch("ana");
    c.run(3000);
    const minority = ["ana", "ben"].map((n) => c.get(n));
    const majority = ["cai", "dee", "eli", "fay"].map((n) => c.get(n));
    c.net.partition([minority.map((n) => n.transportId), majority.map((n) => n.transportId)]);
    c.runUntil(() => c.hosts(majority).length === 1 && majority.every((n) => !n.coord.view().paused), 15_000);
    c.runUntil(() => minority.every((n) => n.coord.view().mode !== "host"), 5000);
    const minoritySeq = minority[0]!.coord.view().lastSeq;
    c.run(5000);
    expect(minority[0]!.coord.view().lastSeq).toBe(minoritySeq); // frozen
    expect(majority[0]!.coord.view().lastSeq).toBeGreaterThan(minoritySeq);
    c.net.heal();
    c.runUntil(() => minority.every((n) => n.coord.view().mode === "follower"), 15_000);
    c.run(2000);
    c.settle();
    expect(c.consistent()).toBe(true);
  });

  it("14. a player tops out while the host is dying: elimination survives exactly once", () => {
    const c = new Cluster();
    c.lobby(["ana", "ben", "cai", "dee"], { cai: 0 });
    c.startMatch("ana");
    const cai = c.get("cai");
    c.runUntil(() => cai.coord.view().localSim?.s.toppedOut === true, 120_000, 10);
    c.goOffline("ana"); // host dies with the knockout possibly still uncommitted
    const rest = ["ben", "cai", "dee"].map((n) => c.get(n));
    c.runUntil(() => c.hosts(rest).length === 1 && rest.every((n) => !n.coord.view().paused), 15_000);
    c.run(1000);
    c.settle();
    expect(c.consistent(rest)).toBe(true);
    const mp = c.get("ben").coord.view().state!.match!.players[cai.pid]!;
    expect(mp.alive).toBe(false);
    const kos = rest.map((n) => n.coord.view().state!.match!.players[cai.pid]!.placement);
    expect(new Set(kos).size).toBe(1);
  });
});

describe("match end", () => {
  it("15/16. last player standing wins (committed on every peer), then rematch", () => {
    const c = new Cluster();
    c.lobby(["ana", "ben", "cai"], { ben: 0, cai: 0 });
    c.startMatch("ana");
    c.runUntil(() => c.alive().every((n) => n.coord.view().matchEndCommitted), 180_000, 20);
    c.settle();
    expect(c.consistent()).toBe(true);
    const res = c.get("ben").coord.view().state!.lastResult!;
    expect(res.reason).toBe("knockout");
    expect(res.winner).toBe(c.get("ana").pid);
    expect(res.rankings.map((r) => r.placement)).toEqual([1, 2, 3]);
    expect(c.get("ana").coord.rematch()).toBe(true);
    c.runUntil(() => c.alive().every((n) => n.coord.view().phase === "lobby"));
    c.get("ben").coord.setReady(true);
    c.get("cai").coord.setReady(true);
    c.runUntil(() => c.get("ana").coord.canStart().ok);
    c.startMatch("ana");
    c.run(2000);
    c.settle();
    expect(c.consistent()).toBe(true);
  });

  it("2-player match where the opponent vanishes ends with no result rather than a guessed winner", () => {
    const c = new Cluster({ migrationGiveUpMs: 6000 });
    c.lobby(["ana", "ben"]);
    c.startMatch("ana");
    c.run(2000);
    c.goOffline("ben");
    c.runUntil(() => c.get("ana").coord.view().abandoned && c.get("ben").coord.view().abandoned, 20_000);
    expect(c.get("ana").coord.view().state!.lastResult).toBeNull();
    expect(c.get("ben").coord.view().state!.lastResult).toBeNull();
  });
});

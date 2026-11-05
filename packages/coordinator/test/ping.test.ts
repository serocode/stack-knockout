import { describe, expect, it } from "vitest";
import { Cluster } from "./harness.js";

describe("ping to host", () => {
  it("every peer knows every player's ping to the host, and it follows a host change", () => {
    const c = new Cluster({}, 30);
    c.lobby(["ana", "ben", "cai"]);
    c.run(3000);
    const pids = ["ana", "ben", "cai"].map((n) => c.get(n).pid);
    for (const observer of ["ana", "ben", "cai"]) {
      const coord = c.get(observer).coord;
      expect(coord.pingToHost(pids[0]!)).toBe(0); // ana hosts
      expect(coord.pingToHost(pids[1]!)).toBeGreaterThanOrEqual(55);
      expect(coord.pingToHost(pids[1]!)).toBeLessThanOrEqual(70);
      expect(coord.pingToHost(pids[2]!)).toBeGreaterThanOrEqual(55);
    }
    c.startMatch("ana");
    c.closeTab("ana", false);
    c.runUntil(() => c.hosts().length === 1 && c.consistent(), 20_000);
    c.run(3000);
    const host = c.hosts()[0]!;
    const other = c.alive().find((n) => n !== host)!;
    expect(other.coord.pingToHost(host.pid)).toBe(0);
    expect(other.coord.pingToHost(other.pid)).toBeGreaterThanOrEqual(55);
    expect(host.coord.pingToHost(other.pid)).toBeGreaterThanOrEqual(55);
  });
});

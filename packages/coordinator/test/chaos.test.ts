import { describe, expect, it } from "vitest";
import { rngNext } from "@tk/engine";
import { Cluster } from "./harness.js";

const SIX = ["ana", "ben", "cai", "dee", "eli", "fay"];

/**
 * Randomized fault injection. Invariants checked continuously:
 *  S1  at most one host per epoch while a match is in progress
 *  S2  a committed log position never changes content (committed entries are never lost)
 *  S3  no two peers ever hold different committed match results
 *  L1  after faults stop and the network heals, everyone converges
 */
describe("chaos", () => {
  const from = Number(process.env.CHAOS_FROM ?? 1);
  const count = Number(process.env.CHAOS_SEEDS ?? 10);
  for (let seed = from; seed < from + count; seed++) {
    it(`seed ${seed}: safety holds under random crashes, partitions and reconnects`, () => {
      let rng = seed * 7919;
      const rand = () => {
        const [v, n] = rngNext(rng);
        rng = n;
        return v;
      };
      const c = new Cluster({ migrationGiveUpMs: 120_000, reconnectGraceMs: 120_000 });
      // Odd seeds use weak bots so matches finish mid-chaos and S3 is exercised.
      c.lobby(SIX, seed % 2 ? { ben: 0.15, cai: 0.1, dee: 0.1, eli: 0.05, fay: 0.05 } : { eli: 0.4, fay: 0.5 });
      c.startMatch("ana");

      const committed = new Map<number, string>();
      const results = new Set<string>();
      const hostByEpoch = new Map<number, string>();
      const offline = new Set<string>();
      let violations: string[] = [];

      const check = () => {
        for (const n of c.alive()) {
          const v = n.coord.view();
          const log = n.coord.debugLog;
          if (!log || !v.state) continue;
          if (v.mode === "host" && (v.state.phase === "playing" || v.state.phase === "countdown")) {
            const h = hostByEpoch.get(v.epoch);
            if (h && h !== n.pid) violations.push(`two hosts in epoch ${v.epoch}`);
            hostByEpoch.set(v.epoch, n.pid);
          }
          for (const e of log.entriesAfter(0)) {
            if (e.seq > v.commit) break;
            const s = JSON.stringify(e);
            const prev = committed.get(e.seq);
            if (prev !== undefined && prev !== s) {
              if (!violations.length) console.log("VIOLATION", n.name, v.mode, v.state.phase, "commit", v.commit, "\n old:", prev, "\n new:", s);
              violations.push(`committed seq ${e.seq} changed`);
            }
            committed.set(e.seq, s);
          }
          if (v.matchEndCommitted && v.state.lastResult) results.add(`${v.state.lastResult.matchId}:${v.state.lastResult.winner}`);
        }
        const perMatch = new Map<string, Set<string>>();
        for (const r of results) {
          const [m, w] = r.split(":") as [string, string];
          if (!perMatch.has(m)) perMatch.set(m, new Set());
          perMatch.get(m)!.add(w);
        }
        for (const [m, ws] of perMatch) if (ws.size > 1) violations.push(`conflicting results for ${m}`);
      };

      for (let step = 0; step < 24; step++) {
        const r = rand();
        const victim = SIX[Math.floor(rand() * SIX.length)]!;
        if (r < 0.35 && !offline.has(victim)) {
          c.goOffline(victim);
          offline.add(victim);
        } else if (r < 0.65 && offline.size > 0) {
          const back = [...offline][Math.floor(rand() * offline.size)]!;
          c.goOnline(back);
          offline.delete(back);
        } else if (r < 0.8) {
          const shuffled = [...SIX].sort(() => rand() - 0.5);
          const cut = 1 + Math.floor(rand() * 5);
          c.net.partition([shuffled.slice(0, cut).map((n) => c.get(n).transportId), shuffled.slice(cut).map((n) => c.get(n).transportId)]);
        } else {
          c.net.heal();
        }
        const dur = 500 + Math.floor(rand() * 4000);
        for (let t = 0; t < dur; t += 100) {
          c.run(100);
          check();
        }
        if (violations.length) break;
      }
      expect(violations).toEqual([]);

      // Liveness: stop faults, heal everything, converge.
      for (const n of offline) c.goOnline(n);
      c.net.heal();
      c.runUntil(() => c.hosts().length === 1 && c.alive().every((n) => n.coord.view().mode === "follower" || n.coord.view().mode === "host"), 40_000);
      c.run(2000);
      c.settle(2500);
      check();
      expect(violations).toEqual([]);
      expect(c.consistent()).toBe(true);
      if (seed % 2) expect(results.size).toBeGreaterThan(0);
    });
  }
});

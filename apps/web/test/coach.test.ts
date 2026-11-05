import { describe, expect, it } from "vitest";
import { LiveController, PlayerSim, botPlacement } from "@tk/engine";
import { bestSuggestion, dropAt, reachable, steerTo } from "../src/coach/coach";

describe("coaching helpers", () => {
  it("steering to a suggestion produces exactly that placement, and the sim accepts it", () => {
    const sim = PlayerSim.create(1234);
    let rng = 7;
    for (let i = 0; i < 40; i++) {
      // Coach suggests a spot; the player takes it with one key.
      const s = bestSuggestion(sim)!;
      expect(reachable(sim.s.board, s.piece)).toBe(true);
      const c = new LiveController(sim);
      const placed = steerTo(c, s, sim.s.board);
      expect(placed).not.toBeNull();
      expect({ type: placed!.type, x: placed!.x, y: placed!.y, rot: placed!.rot, hold: placed!.usedHold }).toEqual({ ...s.piece, hold: s.usedHold });
      expect(sim.applyPlacement(placed!, []).ok).toBe(true);
      // Mix in some ordinary bot moves so boards get messy.
      if (i % 3 === 0) {
        const r = botPlacement(sim, rng, 0.3);
        rng = r.rng;
        if (r.placement) sim.applyPlacement(r.placement, []);
      }
      if (sim.s.toppedOut) break;
    }
  });

  it("dropAt lands on the stack and refuses positions outside the well", () => {
    const sim = PlayerSim.create(99);
    const p = dropAt(sim.s.board, "I", 3, 0)!;
    expect(p.y).toBeGreaterThan(30);
    expect(dropAt(sim.s.board, "I", 8, 0)).toBeNull();
  });
});

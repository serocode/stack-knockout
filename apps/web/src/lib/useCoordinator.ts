import { useEffect, useReducer } from "react";
import type { Coordinator } from "@tk/coordinator";

/** Re-render on coordinator changes, plus a slow tick for countdown timers. */
export function useCoordinator(coord: Coordinator | null, tickMs = 250) {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!coord) return;
    const off = coord.onChange(bump);
    const t = window.setInterval(bump, tickMs);
    return () => {
      off();
      window.clearInterval(t);
    };
  }, [coord, tickMs]);
  return coord ? coord.view() : null;
}

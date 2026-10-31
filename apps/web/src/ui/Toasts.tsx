import { useEffect, useState } from "react";
import { audio } from "../audio/audio";
import { fx } from "../fx/fx";
import { onUnlock, type UnlockEvent } from "../progress/profile";
import { getPrefs } from "../lib/prefs";

interface Toast {
  id: number;
  e: UnlockEvent;
}

/** Celebrates tier unlocks and new achievements anywhere in the app. */
export function UnlockToasts({ go }: { go: (h: string) => void }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    let n = 0;
    return onUnlock((e) => {
      const id = n++;
      setToasts((t) => [...t.slice(-2), { id, e }]);
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), e.kind === "tier" ? 9000 : 6000);
      const P = getPrefs();
      fx.reduceMotion = P.reduceMotion;
      fx.reduceFlashing = P.reduceFlashing;
      if (e.kind === "tier") {
        audio.play("win");
        fx.burst({ x: innerWidth / 2 - 160, y: 40, w: 320, h: 80 }, "confetti", 4);
      } else {
        audio.play("b2b");
      }
    });
  }, []);
  if (!toasts.length) return null;
  return (
    <div className="unlock-toasts" aria-live="polite">
      {toasts.map(({ id, e }) =>
        e.kind === "tier" ? (
          <button key={id} className="unlock-toast tier" style={{ ["--tier" as string]: e.tier.color }} onClick={() => go("#/profile")}>
            <span className="unlock-icon">◆</span>
            <span>
              <b>{e.tier.name} tier reached!</b>
              <span className="small">{e.rewards.length ? `Unlocked: ${e.rewards.map((r) => r.label).join(", ")}` : "New rank badge"}</span>
            </span>
          </button>
        ) : (
          <button key={id} className="unlock-toast" onClick={() => go("#/profile")}>
            <span className="unlock-icon">{e.achievement.icon}</span>
            <span>
              <b>Achievement: {e.achievement.name}</b>
              <span className="small">{e.achievement.desc}</span>
            </span>
          </button>
        ),
      )}
    </div>
  );
}

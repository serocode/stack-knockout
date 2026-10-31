import { TIERS, nextTier, rewardsFor, tierForScore, type Tier } from "../cosmetics/catalog";
import { savedName } from "../lib/identity";
import { usePrefs } from "../lib/prefs";
import { ACHIEVEMENTS, resetProfile, useProfile } from "../progress/profile";

export function TierBadge({ tier, small = false }: { tier: Tier; small?: boolean }) {
  return (
    <span className={`tier-badge ${small ? "sm" : ""}`} style={{ ["--tier" as string]: tier.color }} title={`${tier.name} tier`}>
      <span className="gem">◆</span>
      {!small && tier.name}
    </span>
  );
}

export function TierProgress({ score }: { score: number }) {
  const cur = tierForScore(score);
  const nxt = nextTier(score);
  const pct = nxt ? ((score - cur.score) / (nxt.score - cur.score)) * 100 : 100;
  return (
    <div className="tier-progress">
      <div className="bar" style={{ ["--tier" as string]: (nxt ?? cur).color }}>
        <span style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
      </div>
      <div className="small muted">
        {nxt ? (
          <>
            <b>{(nxt.score - score).toLocaleString()}</b> points to {nxt.name}
          </>
        ) : (
          "Top tier reached — everything unlocked"
        )}
      </div>
    </div>
  );
}

const STAT_LABELS: [keyof ReturnType<typeof useProfile>["stats"], string][] = [
  ["games", "Games"],
  ["wins", "Wins"],
  ["kos", "Knockouts"],
  ["bestScore", "Best score"],
  ["lines", "Lines"],
  ["quads", "4-line clears"],
  ["tspins", "T-Spins"],
  ["perfectClears", "Perfect clears"],
  ["maxCombo", "Best combo"],
  ["attackSent", "Garbage sent"],
];

export function ProfileScreen({ go }: { go: (h: string) => void }) {
  const p = useProfile();
  const prefs = usePrefs();
  const tier = tierForScore(p.careerScore);
  const unlockedCount = Object.keys(p.achievements).length;
  return (
    <div className="page">
      <div className="panel profile">
        <div className="row between">
          <div className="profile-head">
            <span className="avatar xl">{prefs.cosmetics.avatar}</span>
            <div>
              <h2>{savedName() || "Player"}</h2>
              <TierBadge tier={tier} />
            </div>
          </div>
          <button className="ghost small" onClick={() => go("#/")}>Back</button>
        </div>

        <div className="career">
          <div className="career-score">
            <span className="muted small">Career score</span>
            <b>{p.careerScore.toLocaleString()}</b>
          </div>
          <TierProgress score={p.careerScore} />
        </div>

        <h3>Tier rewards</h3>
        <p className="muted small">Every point you score in practice or online adds to your career score. Rewards are cosmetic and saved in this browser.</p>
        <ol className="tier-road">
          {TIERS.map((t) => {
            const got = p.careerScore >= t.score;
            const rewards = rewardsFor(t.id);
            return (
              <li key={t.id} className={got ? "got" : ""} style={{ ["--tier" as string]: t.color }}>
                <span className="gem">◆</span>
                <div>
                  <b>{t.name}</b> <span className="muted small">{t.score.toLocaleString()}</span>
                  <div className="small muted">{rewards.length ? rewards.map((r) => `${r.kind}: ${r.label}`).join(" · ") : "Your journey starts here"}</div>
                </div>
                <span className="small">{got ? "Unlocked" : "🔒"}</span>
              </li>
            );
          })}
        </ol>

        <h3>
          Achievements <span className="muted small">{unlockedCount}/{ACHIEVEMENTS.length}</span>
        </h3>
        <div className="achievements">
          {ACHIEVEMENTS.map((a) => {
            const at = p.achievements[a.id];
            return (
              <div key={a.id} className={`achievement ${at ? "got" : ""}`} title={at ? `Unlocked ${new Date(at).toLocaleDateString()}` : "Locked"}>
                <span className="ach-icon">{at ? a.icon : "🔒"}</span>
                <div>
                  <b>{a.name}</b>
                  <div className="small muted">{a.desc}</div>
                </div>
              </div>
            );
          })}
        </div>

        <h3>Stats</h3>
        <div className="stat-grid">
          {STAT_LABELS.map(([k, label]) => (
            <div key={k} className="stat">
              <b>{p.stats[k].toLocaleString()}</b>
              <span className="muted small">{label}</span>
            </div>
          ))}
        </div>

        <div className="row">
          <button
            className="ghost small danger"
            onClick={() => {
              if (confirm("Reset your career score, stats and achievements in this browser? Unlocked premium skins will lock again.")) resetProfile();
            }}
          >
            Reset progress
          </button>
        </div>
      </div>
    </div>
  );
}

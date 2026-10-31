import { useEffect, useMemo, useRef, useState } from "react";
import { BOARD_WIDTH, createBoard, type Board, type PiecePos } from "@tk/engine";
import { audio } from "../audio/audio";
import {
  AVATARS,
  BACKGROUNDS,
  BLOCK_CORNERS,
  BLOCK_GAPS,
  BLOCK_GLOWS,
  BLOCK_PATTERNS,
  BLOCK_SKINS,
  EFFECTS,
  FRAMES,
  GARBAGES,
  GHOSTS,
  MUSIC_TRACKS,
  PRESET_PALETTES,
  SOUND_PACKS,
  THEMES,
  isUnlocked,
  tierById,
  tierForScore,
  type Option,
} from "../cosmetics/catalog";
import { fx } from "../fx/fx";
import { setCosmetics, setPrefs, usePrefs } from "../lib/prefs";
import { useProfile } from "../progress/profile";
import { drawBoard, lookOf, sizeCanvas } from "../render/draw";
import { drawBlock, type Look } from "../render/skins";
import { TierBadge, TierProgress } from "./Profile";

type Tab = "blocks" | "board" | "frame" | "effects" | "avatar" | "theme" | "sound";
const TABS: { id: Tab; label: string }[] = [
  { id: "blocks", label: "Blocks" },
  { id: "board", label: "Board" },
  { id: "frame", label: "Frame" },
  { id: "effects", label: "Effects" },
  { id: "avatar", label: "Avatar" },
  { id: "theme", label: "Theme" },
  { id: "sound", label: "Sound" },
];
const PIECE_NAMES = ["I", "O", "T", "S", "Z", "J", "L"];

/** A fixed demo stack so every look can be judged on the same board. */
function demoBoard(): Board {
  const b = createBoard();
  const rows: string[] = [
    "..........",
    "....2.....",
    "..662.....",
    "6.3337.8..",
    "66533771.8",
    "8885544188",
    "88.8888888",
    "8888.88888",
  ];
  rows.forEach((r, i) => {
    const y = 40 - rows.length + i;
    for (let x = 0; x < BOARD_WIDTH; x++) {
      const ch = r[x]!;
      if (ch !== ".") b[y * BOARD_WIDTH + x] = Number(ch);
    }
  });
  return b;
}
const DEMO_PIECE: PiecePos = { type: "T", x: 3, y: 24, rot: 2 };

/** Live, animated row of blocks in a given look. */
function Swatch({ look, values = [1, 3, 5, 6], size = 18 }: { look: Look; values?: number[]; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const lookRef = useRef(look);
  lookRef.current = look;
  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (!ref.current) return;
      const ctx = sizeCanvas(ref.current, values.length + 0.6, 1.6, size);
      ctx.clearRect(0, 0, (values.length + 0.6) * size, 1.6 * size);
      values.forEach((v, i) => drawBlock(ctx, size * 0.3 + i * size, size * 0.3, size, v, lookRef.current, t, i, 0));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [values.join(), size]);
  return <canvas ref={ref} className="swatch" />;
}

function LockNote({ tier, career }: { tier: NonNullable<Option["tier"]>; career: number }) {
  const t = tierById(tier);
  return (
    <span className="lock-note" style={{ ["--tier" as string]: t.color }}>
      🔒 {t.name} · {(t.score - career).toLocaleString()} to go
    </span>
  );
}

function Tiles<T extends string>({
  options,
  value,
  onPick,
  render,
  career,
}: {
  options: readonly Option<T>[];
  value: T;
  onPick: (v: T) => void;
  render?: (o: Option<T>) => React.ReactNode;
  career: number;
}) {
  return (
    <div className="tiles">
      {options.map((o) => {
        const open = isUnlocked(o, career);
        return (
          <button
            key={o.id}
            className={`tile ${value === o.id ? "sel" : ""} ${open ? "" : "locked"} ${o.tier ? "premium" : ""}`}
            style={o.tier ? { ["--tier" as string]: tierById(o.tier).color } : undefined}
            onClick={() => (open ? onPick(o.id) : audio.play("garbageWarn"))}
            aria-disabled={!open}
            title={open ? o.hint : `Unlocks at ${tierById(o.tier!).name} (${tierById(o.tier!).score.toLocaleString()} career points)`}
          >
            {o.tier && <span className="premium-gem">◆</span>}
            {render?.(o)}
            <span className="tile-label">{o.label}</span>
            {open ? o.hint && <span className="tile-hint">{o.hint}</span> : <LockNote tier={o.tier!} career={career} />}
          </button>
        );
      })}
    </div>
  );
}

export function Customize({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const prefs = usePrefs();
  const profile = useProfile();
  const career = profile.careerScore;
  const c = prefs.cosmetics;
  const look = lookOf(c);
  const [tab, setTab] = useState<Tab>("blocks");
  const boardRef = useRef<HTMLCanvasElement>(null);
  const wellRef = useRef<HTMLDivElement>(null);
  const board = useMemo(demoBoard, []);
  const lookRef = useRef(look);
  lookRef.current = look;
  const reduce = useRef(prefs.reduceMotion);
  reduce.current = prefs.reduceMotion;

  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (!boardRef.current) return;
      drawBoard(boardRef.current, { board, size: 18, look: lookRef.current, active: DEMO_PIECE, ghostY: 30, time: t, still: reduce.current });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [board]);

  const previewEffect = (effect = c.effect) => {
    audio.unlock();
    fx.reduceMotion = prefs.reduceMotion;
    fx.reduceFlashing = prefs.reduceFlashing;
    if (boardRef.current) fx.rows(boardRef.current, [16, 17, 18, 19], 18, effect, 3, look.palette);
    fx.shake(wellRef.current, 0.6);
    audio.play("clear4");
  };

  return (
    <div className={embedded ? "customize-overlay" : "page"}>
      <div className="panel customize">
        <div className="row between">
          <h2>Customize</h2>
          <button className="ghost small" onClick={onClose}>{embedded ? "Done" : "Back"}</button>
        </div>
        <div className="customize-tier">
          <TierBadge tier={tierForScore(career)} />
          <TierProgress score={career} />
        </div>
        <p className="muted small">Looks only — nothing here changes how the game plays. Items marked ◆ are premium and unlock as your career score grows.</p>
        <div className="customize-body">
          <div className="preview">
            <div ref={wellRef} className={`well frame frame-${c.frame}`}>
              <canvas ref={boardRef} />
            </div>
            <span className="avatar big-avatar">{c.avatar}</span>
            <button className="small" onClick={() => previewEffect()}>Preview clear effect</button>
          </div>
          <div className="options">
            <div className="tabs" role="tablist">
              {TABS.map((t) => (
                <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "blocks" && (
              <>
                <h3>Block skin</h3>
                <Tiles career={career} options={BLOCK_SKINS} value={c.block} onPick={(block) => setCosmetics({ block })} render={(o) => <Swatch look={{ ...look, skin: o.id }} />} />
                <h3>Shape</h3>
                <div className="shape-grid">
                  <div>
                    <label>Corners</label>
                    <Tiles career={career} options={BLOCK_CORNERS} value={c.corners} onPick={(corners) => setCosmetics({ corners })} render={(o) => <Swatch look={{ ...look, corners: o.id }} values={[3, 3]} />} />
                  </div>
                  <div>
                    <label>Spacing</label>
                    <Tiles career={career} options={BLOCK_GAPS} value={c.gap} onPick={(gap) => setCosmetics({ gap })} render={(o) => <Swatch look={{ ...look, gap: o.id }} values={[3, 3]} />} />
                  </div>
                  <div>
                    <label>Pattern</label>
                    <Tiles career={career} options={BLOCK_PATTERNS} value={c.pattern} onPick={(pattern) => setCosmetics({ pattern })} render={(o) => <Swatch look={{ ...look, pattern: o.id }} values={[3, 3]} />} />
                  </div>
                  <div>
                    <label>Glow</label>
                    <Tiles career={career} options={BLOCK_GLOWS} value={c.glow} onPick={(glow) => setCosmetics({ glow })} render={(o) => <Swatch look={{ ...look, glow: o.id }} values={[3, 3]} />} />
                  </div>
                </div>
                <h3>Colours</h3>
                <div className="tiles">
                  {PRESET_PALETTES.map((p) => {
                    const open = isUnlocked(p, career);
                    return (
                      <button
                        key={p.id}
                        className={`tile ${p.colors.join() === c.palette.join() ? "sel" : ""} ${open ? "" : "locked"} ${p.tier ? "premium" : ""}`}
                        style={p.tier ? { ["--tier" as string]: tierById(p.tier).color } : undefined}
                        onClick={() => (open ? setCosmetics({ palette: [...p.colors] }) : audio.play("garbageWarn"))}
                        aria-disabled={!open}
                      >
                        {p.tier && <span className="premium-gem">◆</span>}
                        <Swatch look={{ ...look, palette: p.colors }} values={[1, 2, 3, 4, 5, 6, 7]} size={14} />
                        <span className="tile-label">{p.label}</span>
                        {!open && <LockNote tier={p.tier!} career={career} />}
                      </button>
                    );
                  })}
                </div>
                <div className="custom-colors">
                  {c.palette.map((col, i) => (
                    <label key={i} className="color-pick">
                      <input
                        type="color"
                        value={col}
                        onChange={(e) => {
                          const next = [...c.palette];
                          next[i] = e.target.value;
                          setCosmetics({ palette: next });
                        }}
                      />
                      <span>{PIECE_NAMES[i]}</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {tab === "board" && (
              <>
                <h3>Background</h3>
                <Tiles career={career} options={BACKGROUNDS} value={c.background} onPick={(background) => setCosmetics({ background })} />
                <h3>Ghost piece</h3>
                <Tiles career={career} options={GHOSTS} value={c.ghost} onPick={(ghost) => setCosmetics({ ghost })} />
                <h3>Garbage blocks</h3>
                <Tiles career={career} options={GARBAGES} value={c.garbage} onPick={(garbage) => setCosmetics({ garbage })} render={(o) => <Swatch look={{ ...look, garbage: o.id }} values={[8, 8, 8]} />} />
              </>
            )}

            {tab === "frame" && (
              <>
                <h3>Board frame</h3>
                <Tiles
                  career={career}
                  options={FRAMES}
                  value={c.frame}
                  onPick={(frame) => setCosmetics({ frame })}
                  render={(o) => (
                    <span className={`frame-chip frame frame-${o.id}`}>
                      <span className="frame-chip-inner" />
                    </span>
                  )}
                />
              </>
            )}

            {tab === "effects" && (
              <>
                <h3>Clear &amp; attack effects</h3>
                <Tiles
                  career={career}
                  options={EFFECTS}
                  value={c.effect}
                  onPick={(effect) => {
                    setCosmetics({ effect });
                    previewEffect(effect);
                  }}
                />
              </>
            )}

            {tab === "avatar" && (
              <>
                <h3>Avatar</h3>
                <div className="avatar-grid">
                  {AVATARS.map((a) => {
                    const open = isUnlocked(a, career);
                    return (
                      <button
                        key={a.id}
                        className={`avatar-pick ${c.avatar === a.id ? "sel" : ""} ${open ? "" : "locked"} ${a.tier ? "premium" : ""}`}
                        style={a.tier ? { ["--tier" as string]: tierById(a.tier).color } : undefined}
                        onClick={() => (open ? setCosmetics({ avatar: a.id }) : audio.play("garbageWarn"))}
                        aria-label={open ? `Avatar ${a.id}` : `Locked avatar, unlocks at ${tierById(a.tier!).name}`}
                        title={open ? undefined : `Unlocks at ${tierById(a.tier!).name} (${tierById(a.tier!).score.toLocaleString()})`}
                      >
                        {a.id}
                        {!open && <span className="mini-lock">🔒</span>}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {tab === "theme" && (
              <>
                <h3>Interface theme</h3>
                <p className="muted small">Only changes your own screen.</p>
                <Tiles career={career} options={THEMES} value={prefs.theme} onPick={(theme) => setPrefs({ theme })} render={(o) => <span className={`theme-chip theme-chip-${o.id}`} />} />
              </>
            )}

            {tab === "sound" && (
              <>
                <h3>Sound effects</h3>
                <Tiles
                  career={career}
                  options={SOUND_PACKS}
                  value={prefs.soundPack}
                  onPick={(soundPack) => {
                    setPrefs({ soundPack });
                    audio.unlock();
                    window.setTimeout(() => audio.play("clear3"), 30);
                  }}
                />
                <h3>Music</h3>
                <Tiles
                  career={career}
                  options={MUSIC_TRACKS}
                  value={prefs.music}
                  onPick={(music) => {
                    audio.unlock();
                    setPrefs({ music });
                  }}
                />
                <Volume label="Master" value={prefs.masterVolume} onChange={(masterVolume) => setPrefs({ masterVolume })} />
                <Volume label="Music" value={prefs.musicVolume} onChange={(musicVolume) => setPrefs({ musicVolume })} />
                <Volume label="Effects" value={prefs.sfxVolume} onChange={(sfxVolume) => setPrefs({ sfxVolume })} onRelease={() => audio.play("clear2")} />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Volume({ label, value, onChange, onRelease }: { label: string; value: number; onChange: (v: number) => void; onRelease?: () => void }) {
  return (
    <label className="volume">
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        onPointerUp={() => {
          audio.unlock();
          onRelease?.();
        }}
      />
      <span className="mono small">{Math.round(value * 100)}</span>
    </label>
  );
}

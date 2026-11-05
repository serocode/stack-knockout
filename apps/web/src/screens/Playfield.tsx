import { useEffect, useRef, useState, type ReactNode } from "react";
import { LiveController, type Command, type LockResult, type PiecePos, type Placement, type PlayerSim } from "@tk/engine";
import { audio } from "../audio/audio";
import { steerTo } from "../coach/coach";
import { fx, tierFor, vibrate } from "../fx/fx";
import { isTouchDevice } from "../lib/device";
import { InputHandler } from "../lib/input";
import { usePrefs } from "../lib/prefs";
import { recordLock } from "../progress/profile";
import { loadSettings } from "../lib/settings";
import { drawBoard, drawPieceList, lookOf, rowsClearedBy, stackDanger, FLASH_MS, type RowFlash } from "../render/draw";

interface Props {
  sim: PlayerSim;
  /** Read the current sim every frame (it is replaced on resync between React renders). */
  getSim?: () => PlayerSim | null;
  paused: boolean;
  gravityMs: number;
  cellSize: number;
  /** Rows queued against us (not yet landing). */
  incomingQueued: number;
  /** Rows that land on our next non-clearing lock. */
  incomingLanding: number;
  onLock: (p: Placement) => LockResult | null;
  onPiece?: (p: PiecePos) => void;
  overlay?: string | null;
  /** Extra overlay content, e.g. the countdown. */
  children?: ReactNode;
  /** data-board id so attack projectiles can find this board. */
  boardId?: string;
  /** Coaching suggestions for the current piece, newest first (the first is what G takes). */
  hints?: PlayfieldHint[];
  onHintUsed?: (h: PlayfieldHint) => void;
}

export interface PlayfieldHint {
  /** Coach's player id. */
  coach: string;
  /** Piece index the suggestion is for. */
  idx: number;
  usedHold: boolean;
  piece: PiecePos;
  color: string;
  /** e.g. "🦊 Sam" */
  label: string;
}

/** The local player's board: owns input, the falling-piece controller, effects and the render loop. */
export function Playfield({ sim, getSim, paused, gravityMs, cellSize, incomingQueued, incomingLanding, onLock, onPiece, overlay, children, boardId, hints, onHintUsed }: Props) {
  const prefs = usePrefs();
  const boardRef = useRef<HTMLCanvasElement>(null);
  const wellRef = useRef<HTMLDivElement>(null);
  const holdRef = useRef<HTMLCanvasElement>(null);
  const nextRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ sim, getSim, paused, gravityMs, onLock, onPiece, overlay, prefs, hints, onHintUsed });
  live.current = { sim, getSim, paused, gravityMs, onLock, onPiece, overlay, prefs, hints, onHintUsed };
  const input = useRef<InputHandler | null>(null);
  /** Set by G / the hint card; consumed on the next frame by the controller loop. */
  const acceptHint = useRef(false);
  const [hintMiss, setHintMiss] = useState<number | null>(null);

  useEffect(() => {
    const s = loadSettings();
    const inp = new InputHandler(s.dasMs, s.arrMs);
    input.current = inp;
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.code === "KeyG" && !e.repeat && live.current.hints?.length) {
        acceptHint.current = true;
        e.preventDefault();
        return;
      }
      if (inp.keyDown(e.code)) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      if (inp.keyUp(e.code)) e.preventDefault();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    const blur = () => inp.reset();
    window.addEventListener("blur", blur);

    let ctl: LiveController | null = null;
    let ctlSim: PlayerSim | null = null;
    let last = performance.now();
    let raf = 0;
    let flashes: RowFlash[] = [];
    let wasDanger = false;

    const feedback = (p: Placement, r: LockResult | null, cleared: number[], hard: boolean) => {
      const P = live.current.prefs;
      fx.reduceMotion = P.reduceMotion;
      fx.reduceFlashing = P.reduceFlashing;
      const look = lookOf(P.cosmetics);
      if (!r) return;
      recordLock(r, (live.current.getSim?.() ?? live.current.sim).s.b2bChain);
      const tier = tierFor(r);
      if (tier === 0) {
        audio.play(hard ? "hardDrop" : "lock");
        if (hard) fx.shake(wellRef.current, 0.18);
        if (P.haptics) vibrate(8);
      } else {
        const now = performance.now();
        flashes = flashes.concat(cleared.map((row) => ({ row, at: now })));
        if (boardRef.current) fx.rows(boardRef.current, cleared, cellSize, P.cosmetics.effect, tier, look.palette);
        if (r.perfectClear) audio.play("perfect");
        else if (r.tspin !== "none") audio.play("tspin");
        else audio.play(`clear${Math.min(4, r.lines) as 1 | 2 | 3 | 4}`);
        if (r.b2bBonus) audio.play("b2b");
        if (r.combo > 0) audio.play("combo", { combo: r.combo });
        fx.shake(wellRef.current, [0, 0.25, 0.4, 0.62, 0.85][tier]!);
        if (P.haptics) vibrate(tier >= 3 ? [20, 30, 40] : 18);
      }
      if (r.toppedOut) audio.play("topOut");
      void p;
    };

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(100, t - last);
      last = t;
      const L0 = live.current;
      const L = { ...L0, sim: L0.getSim?.() ?? L0.sim };
      if (ctlSim !== L.sim) {
        ctl = new LiveController(L.sim);
        ctlSim = L.sim;
        flashes = [];
      }
      const c = ctl!;
      c.setConfig({ gravityMs: L.gravityMs });
      const playable = !L.paused && !L.sim.s.toppedOut;
      if (playable) {
        const lock = (p: Placement | null, hard: boolean) => {
          if (!p) return;
          const cleared = rowsClearedBy(L.sim.s.board, { type: p.type, x: p.x, y: p.y, rot: p.rot });
          const r = L.onLock(p);
          c.reset();
          feedback(p, r, cleared, hard);
        };
        for (const cmd of inp.drain(dt)) {
          const before = c.piece;
          const wasHold = c.holdUsed;
          const placed = c.command(cmd);
          if (placed) lock(placed, cmd === "hardDrop");
          else if (cmd === "hold" && !wasHold && c.holdUsed) audio.play("hold");
          else if (c.piece !== before && (cmd === "left" || cmd === "right")) audio.play("move");
          else if (c.piece !== before && (cmd === "cw" || cmd === "ccw")) audio.play("rotate");
        }
        const current = (L.hints ?? []).filter((h) => h.idx === L.sim.s.piecesPlaced);
        if (acceptHint.current) {
          acceptHint.current = false;
          const h = current[0];
          if (h) {
            const placed = steerTo(c, h, L.sim.s.board);
            if (placed) {
              lock(placed, true);
              L.onHintUsed?.(h);
            } else setHintMiss(h.idx);
          }
        }
        lock(c.tick(dt), false);
        L.onPiece?.(c.piece);
      } else {
        inp.drain(dt);
        acceptHint.current = false;
      }

      const danger = stackDanger(L.sim.s.board);
      const isDanger = danger > 0.75 && playable;
      if (isDanger !== wasDanger) {
        audio.setDanger(isDanger);
        wasDanger = isDanger;
      }
      flashes = flashes.filter((f) => t - f.at < FLASH_MS);
      const look = lookOf(L.prefs.cosmetics);
      if (boardRef.current) {
        drawBoard(boardRef.current, {
          board: L.sim.s.board,
          size: cellSize,
          look,
          active: playable || L.paused ? c.piece : null,
          ghostY: playable ? c.ghostY() : null,
          dim: !!L.overlay,
          label: L.overlay ?? undefined,
          time: t,
          flashes,
          still: L.prefs.reduceMotion,
          reduceFlashing: L.prefs.reduceFlashing,
          danger,
          hints: playable ? (L.hints ?? []).filter((h) => h.idx === L.sim.s.piecesPlaced).map((h, i) => ({ piece: h.piece, color: h.color, primary: i === 0 })) : undefined,
        });
      }
      if (holdRef.current) drawPieceList(holdRef.current, [c.displayHold()], Math.round(cellSize * 0.6), look, c.holdUsed);
      if (nextRef.current) drawPieceList(nextRef.current, c.displayNext(5), Math.round(cellSize * 0.6), look);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      audio.setDanger(false);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [cellSize]);

  // ---------------------------------------------------------------- touch gestures
  const gesture = useRef<{ id: number; x: number; y: number; t: number; moved: number; soft: boolean; travelled: number } | null>(null);
  const gesturesOn = prefs.touchMode !== "buttons";
  const onPointerDown = (e: React.PointerEvent) => {
    if (!gesturesOn || e.pointerType === "mouse") return;
    e.preventDefault();
    audio.unlock();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: 0, soft: false, travelled: 0 };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    g.travelled = Math.max(g.travelled, Math.hypot(dx, dy));
    const step = cellSize * 0.85;
    const want = Math.trunc(dx / step);
    while (g.moved < want) {
      input.current?.tap("right");
      g.moved++;
    }
    while (g.moved > want) {
      input.current?.tap("left");
      g.moved--;
    }
    // Slow, deliberate drag down = soft drop.
    const soft = dy > cellSize * 1.5 && Math.abs(dy) > Math.abs(dx);
    if (soft !== g.soft) {
      g.soft = soft;
      input.current?.tap(soft ? "softDropOn" : "softDropOff");
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    gesture.current = null;
    if (g.soft) input.current?.tap("softDropOff");
    const dt = performance.now() - g.t;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const vy = dy / Math.max(1, dt);
    let cmd: Command | null = null;
    if (g.travelled < cellSize * 0.5 && dt < 300) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      cmd = e.clientX < r.left + r.width / 2 ? "ccw" : "cw";
    } else if (dy > cellSize * 2 && vy > 0.8 && Math.abs(dy) > Math.abs(dx) * 1.5) cmd = "hardDrop";
    else if (dy < -cellSize * 2 && Math.abs(dy) > Math.abs(dx) * 1.5) cmd = "hold";
    if (cmd) input.current?.tap(cmd);
  };

  const button = (cmd: Parameters<InputHandler["press"]>[0]) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      audio.unlock();
      input.current?.press(cmd);
      if (prefs.haptics) vibrate(5);
    },
    onPointerUp: () => input.current?.release(cmd),
    onPointerLeave: () => input.current?.release(cmd),
    onPointerCancel: () => input.current?.release(cmd),
  });

  const total = incomingQueued + incomingLanding;
  const hint = hints?.find((h) => h.idx === sim.s.piecesPlaced) ?? null;
  const hintCount = hints?.filter((h) => h.idx === sim.s.piecesPlaced).length ?? 0;
  const meterPct = (n: number) => `${(Math.min(20, n) / 20) * 100}%`;
  return (
    <div className={`playfield touch-${prefs.touchMode}`}>
      <div className="side">
        <span className="tag">HOLD</span>
        <canvas ref={holdRef} />
        <div className="stats">
          <div><b>{sim.s.lines}</b> lines</div>
          <div><b>{sim.s.score.toLocaleString()}</b> pts</div>
          {sim.s.combo > 0 && <div className="pop" key={`c${sim.s.combo}`}>{sim.s.combo} combo</div>}
          {sim.s.b2bChain > 1 && <div className="pop" key={`b${sim.s.b2bChain}`}>B2B ×{sim.s.b2bChain - 1}</div>}
        </div>
      </div>
      <div ref={wellRef} className={`well frame frame-${prefs.cosmetics.frame}`} data-board={boardId}>
        <div className="meter" title={`${total} incoming`}>
          <div className="meter-queued" style={{ height: meterPct(total) }} />
          <div className="meter-landing" style={{ height: meterPct(incomingLanding) }} />
        </div>
        <canvas
          ref={boardRef}
          className="board-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {children}
      </div>
      <div className="side">
        <span className="tag">NEXT</span>
        <canvas ref={nextRef} />
        {hint && !paused && (
          <button
            className="hint-card"
            style={{ ["--coach" as string]: hint.color }}
            onPointerDown={(e) => {
              e.preventDefault();
              acceptHint.current = true;
            }}
            title="Drop your piece on the suggested spot (G)"
          >
            <span className="hint-from">💡 {hint.label}{hintCount > 1 ? ` +${hintCount - 1}` : ""}</span>
            <span className="hint-act">{hintMiss === hint.idx ? "Can't reach — line it up yourself" : <>{isTouchDevice() ? "Tap to use" : <>Use <kbd>G</kbd></>}{hint.usedHold ? " · holds" : ""}</>}</span>
          </button>
        )}
      </div>
      <div className="touch">
        <div className="pad-left">
          <button aria-label="Move left" {...button("left")}>←</button>
          <button aria-label="Move right" {...button("right")}>→</button>
        </div>
        <div className="pad-mid">
          <button aria-label="Hold" {...button("hold")}>Hold</button>
          <button aria-label="Soft drop" {...button("softDrop")}>↓</button>
          <button aria-label="Hard drop" className="drop" {...button("hardDrop")}>Drop</button>
        </div>
        <div className="pad-right">
          <button aria-label="Rotate counter-clockwise" {...button("ccw")}>↺</button>
          <button aria-label="Rotate clockwise" {...button("cw")}>↻</button>
        </div>
      </div>
    </div>
  );
}

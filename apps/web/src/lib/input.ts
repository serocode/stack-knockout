import type { Command } from "@tk/engine";

/**
 * Keyboard -> engine commands with DAS (delayed auto shift) and ARR (auto
 * repeat rate). Pure timing logic; the engine never sees key codes.
 */
const KEYMAP: Record<string, Command | "softDrop"> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowDown: "softDrop",
  ArrowUp: "cw",
  KeyX: "cw",
  KeyZ: "ccw",
  ControlLeft: "ccw",
  Space: "hardDrop",
  KeyC: "hold",
  ShiftLeft: "hold",
};

export class InputHandler {
  private held: "left" | "right" | null = null;
  private heldFor = 0;
  private repeatAcc = 0;
  private queue: Command[] = [];
  private down = new Set<string>();

  constructor(
    private das: number,
    private arr: number,
  ) {}

  setTiming(das: number, arr: number): void {
    this.das = das;
    this.arr = arr;
  }

  keyDown(code: string): boolean {
    const cmd = KEYMAP[code];
    if (!cmd) return false;
    if (this.down.has(code)) return true;
    this.down.add(code);
    this.press(cmd);
    return true;
  }

  keyUp(code: string): boolean {
    const cmd = KEYMAP[code];
    if (!cmd) return false;
    this.down.delete(code);
    this.release(cmd);
    return true;
  }

  press(cmd: Command | "softDrop"): void {
    if (cmd === "softDrop") return void this.queue.push("softDropOn");
    if (cmd === "left" || cmd === "right") {
      this.held = cmd;
      this.heldFor = 0;
      this.repeatAcc = 0;
    }
    this.queue.push(cmd);
  }

  /** One-shot command with no auto-repeat (touch gestures). */
  tap(cmd: Command): void {
    this.queue.push(cmd);
  }

  release(cmd: Command | "softDrop"): void {
    if (cmd === "softDrop") return void this.queue.push("softDropOff");
    if (cmd === this.held) this.held = null;
  }

  /** Commands to apply this frame. */
  drain(dtMs: number): Command[] {
    if (this.held) {
      this.heldFor += dtMs;
      if (this.heldFor >= this.das) {
        if (this.arr <= 0) {
          for (let i = 0; i < 10; i++) this.queue.push(this.held);
        } else {
          this.repeatAcc += dtMs;
          while (this.repeatAcc >= this.arr) {
            this.repeatAcc -= this.arr;
            this.queue.push(this.held);
          }
        }
      }
    }
    const out = this.queue;
    this.queue = [];
    return out;
  }

  reset(): void {
    this.held = null;
    this.down.clear();
    this.queue = [];
  }
}

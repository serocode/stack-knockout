import type { MusicTrack, SoundPack } from "../cosmetics/catalog";

/**
 * All audio is synthesized with WebAudio: no sample files to ship or license.
 *
 * Bus layout (audio-design guidance): sfx + music -> master -> limiter -> out.
 * Sliders map to bus gains on a perceptual curve; music ducks under big
 * moments; repeated SFX get small random pitch variation.
 */
export type Sfx =
  | "move" | "rotate" | "hold" | "lock" | "hardDrop"
  | "clear1" | "clear2" | "clear3" | "clear4"
  | "tspin" | "b2b" | "combo" | "perfect"
  | "attack" | "cancel" | "garbageIn" | "garbageWarn"
  | "ko" | "win" | "lose" | "count" | "go" | "click" | "join" | "topOut";

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
const perceptual = (v: number) => v * v; // ~dB-like taper for a linear slider

interface Voice {
  wave: OscillatorType;
  attack: number;
  release: number;
  gain: number;
}

const PACKS: Record<Exclude<SoundPack, "off">, { lead: Voice; body: Voice; noise: number }> = {
  arcade: { lead: { wave: "square", attack: 0.003, release: 0.09, gain: 0.16 }, body: { wave: "sawtooth", attack: 0.002, release: 0.12, gain: 0.14 }, noise: 0.22 },
  soft: { lead: { wave: "sine", attack: 0.01, release: 0.25, gain: 0.3 }, body: { wave: "triangle", attack: 0.008, release: 0.3, gain: 0.26 }, noise: 0.09 },
  chip: { lead: { wave: "square", attack: 0.001, release: 0.05, gain: 0.13 }, body: { wave: "square", attack: 0.001, release: 0.07, gain: 0.12 }, noise: 0.18 },
};

// ------------------------------------------------------------------ music data

interface TrackDef {
  bpm: number;
  /** One entry per bar: chord tones (MIDI) and bass root (MIDI). */
  bars: { chord: number[]; bass: number }[];
  arp: "up8" | "wave16" | "pad";
  /** 16th-note grid across all bars (MIDI or null). */
  lead: (number | null)[];
  kick: number[];
  snare: number[];
  hat: number[];
  timbre: { bass: OscillatorType; arp: OscillatorType; lead: OscillatorType };
}

const rest = null;
// Original compositions written for this game.
const TRACKS: Record<Exclude<MusicTrack, "off">, TrackDef> = {
  drift: {
    bpm: 96,
    bars: [
      { chord: [57, 60, 64], bass: 45 },
      { chord: [53, 57, 60], bass: 41 },
      { chord: [48, 52, 55, 60], bass: 48 },
      { chord: [55, 59, 62], bass: 43 },
    ],
    arp: "up8",
    lead: [
      76, rest, rest, 74, rest, rest, 72, rest, 69, rest, rest, rest, rest, rest, 72, rest,
      72, rest, rest, 69, rest, rest, 67, rest, 69, rest, rest, rest, rest, rest, rest, rest,
      67, rest, 69, rest, 72, rest, rest, 74, rest, rest, 76, rest, rest, rest, 79, rest,
      78, rest, rest, 76, rest, rest, 74, rest, 71, rest, rest, rest, rest, rest, rest, rest,
    ],
    kick: [0, 8, 10],
    snare: [4, 12],
    hat: [0, 2, 4, 6, 8, 10, 12, 14],
    timbre: { bass: "triangle", arp: "triangle", lead: "sine" },
  },
  overdrive: {
    bpm: 148,
    bars: [
      { chord: [52, 55, 59], bass: 40 },
      { chord: [48, 52, 55], bass: 36 },
      { chord: [50, 54, 57], bass: 38 },
      { chord: [47, 51, 54], bass: 35 },
    ],
    arp: "up8",
    lead: [
      64, rest, 67, rest, 71, rest, 69, 67, rest, 64, rest, rest, 62, rest, 64, rest,
      60, rest, 64, rest, 67, rest, 69, 67, rest, 64, rest, rest, 67, rest, 72, rest,
      74, rest, 72, rest, 69, rest, 66, rest, 69, rest, 72, rest, 74, rest, 76, rest,
      75, rest, rest, 71, rest, rest, 66, rest, 63, rest, 66, rest, 71, rest, 75, rest,
    ],
    kick: [0, 4, 8, 12],
    snare: [4, 12],
    hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    timbre: { bass: "sawtooth", arp: "square", lead: "square" },
  },
  nocturne: {
    bpm: 84,
    bars: [
      { chord: [62, 65, 69, 74], bass: 38 },
      { chord: [58, 62, 65, 70], bass: 34 },
      { chord: [55, 58, 62, 67], bass: 43 },
      { chord: [57, 61, 64, 69], bass: 45 },
    ],
    arp: "wave16",
    lead: [],
    kick: [0],
    snare: [],
    hat: [8],
    timbre: { bass: "sine", arp: "sine", lead: "triangle" },
  },
};

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private duckNode!: GainNode;
  private noiseBuf: AudioBuffer | null = null;
  private pack: SoundPack = "arcade";
  private track: MusicTrack = "off";
  private vols = { master: 0.8, music: 0.5, sfx: 0.8 };
  private scheduler = 0;
  private step = 0;
  private nextTime = 0;
  private danger = false;
  private lastPlay = new Map<Sfx, number>();

  /** Must be called from a user gesture (tap/click/key) to satisfy autoplay rules. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      limiter.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.connect(limiter);
      this.sfxBus = ctx.createGain();
      this.sfxBus.connect(this.master);
      this.duckNode = ctx.createGain();
      this.duckNode.connect(this.master);
      this.musicBus = ctx.createGain();
      this.musicBus.connect(this.duckNode);
      const len = ctx.sampleRate;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.applyVolumes();
      if (this.track !== "off") this.startMusic();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  configure(o: { pack: SoundPack; track: MusicTrack; master: number; music: number; sfx: number }): void {
    this.pack = o.pack;
    this.vols = { master: o.master, music: o.music, sfx: o.sfx };
    this.applyVolumes();
    if (o.track !== this.track) {
      this.track = o.track;
      this.stopMusic();
      if (this.track !== "off" && this.ctx) this.startMusic();
    }
  }

  setDanger(on: boolean): void {
    this.danger = on;
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(perceptual(this.vols.master), t, 0.02);
    this.sfxBus.gain.setTargetAtTime(perceptual(this.vols.sfx), t, 0.02);
    this.musicBus.gain.setTargetAtTime(perceptual(this.vols.music) * 0.55, t, 0.02);
  }

  /** Briefly lower the music under an important sound, then recover. */
  private duck(depth = 0.4, ms = 700): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const g = this.duckNode.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(depth, t + 0.04);
    g.linearRampToValueAtTime(1, t + ms / 1000);
  }

  // ---------------------------------------------------------------- synth

  private tone(bus: AudioNode, freq: number, start: number, dur: number, v: Voice, opts: { slide?: number; gain?: number } = {}): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = v.wave;
    o.frequency.setValueAtTime(freq, start);
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slide), start + dur);
    const peak = v.gain * (opts.gain ?? 1);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(peak, start + v.attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur + v.release);
    o.connect(g).connect(bus);
    o.start(start);
    o.stop(start + dur + v.release + 0.02);
  }

  private noise(bus: AudioNode, start: number, dur: number, gain: number, filter: number, type: BiquadFilterType = "lowpass"): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = filter;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(f).connect(g).connect(bus);
    src.start(start, Math.random() * 0.5);
    src.stop(start + dur + 0.02);
  }

  play(name: Sfx, opts: { combo?: number } = {}): void {
    if (!this.ctx || this.pack === "off" || this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    // Rate-limit identical rapid-fire sounds (auto-repeat moves).
    const last = this.lastPlay.get(name) ?? 0;
    if ((name === "move" || name === "rotate") && now - last < 0.025) return;
    this.lastPlay.set(name, now);
    const P = PACKS[this.pack];
    const bus = this.sfxBus;
    const vary = 1 + (Math.random() - 0.5) * 0.04;
    const arp = (notes: number[], gap: number, dur: number, v: Voice, g = 1) => notes.forEach((n, i) => this.tone(bus, midi(n) * vary, now + i * gap, dur, v, { gain: g }));
    switch (name) {
      case "move":
        this.tone(bus, 880 * vary, now, 0.015, P.lead, { gain: 0.35 });
        break;
      case "rotate":
        this.tone(bus, 1180 * vary, now, 0.02, P.lead, { gain: 0.35, slide: 1500 });
        break;
      case "hold":
        this.tone(bus, 520 * vary, now, 0.06, P.body, { gain: 0.5, slide: 780 });
        break;
      case "lock":
        this.tone(bus, 180 * vary, now, 0.04, P.body, { gain: 0.6, slide: 110 });
        break;
      case "hardDrop":
        this.tone(bus, 220 * vary, now, 0.06, P.body, { gain: 0.9, slide: 70 });
        this.noise(bus, now, 0.08, P.noise, 1800);
        break;
      case "clear1":
        arp([72, 76], 0.05, 0.08, P.lead);
        break;
      case "clear2":
        arp([72, 76, 79], 0.045, 0.08, P.lead);
        break;
      case "clear3":
        arp([72, 76, 79, 84], 0.04, 0.09, P.lead);
        break;
      case "clear4":
        arp([72, 76, 79, 84, 88], 0.045, 0.12, P.lead, 1.2);
        this.noise(bus, now, 0.35, P.noise * 0.7, 6000, "highpass");
        this.duck();
        break;
      case "tspin":
        arp([79, 83, 86, 91], 0.035, 0.07, P.lead, 1.1);
        this.tone(bus, midi(55), now, 0.25, P.body, { gain: 0.6, slide: midi(67) });
        this.duck(0.5, 500);
        break;
      case "b2b":
        arp([91, 95, 98], 0.03, 0.05, P.lead, 0.7);
        break;
      case "combo": {
        const c = Math.min(12, opts.combo ?? 1);
        this.tone(bus, midi(72 + c * 2) * vary, now, 0.06, P.lead, { gain: 0.8 });
        break;
      }
      case "perfect":
        arp([72, 76, 79, 84, 88, 91, 96], 0.06, 0.18, P.lead, 1.1);
        this.duck(0.25, 1400);
        break;
      case "attack":
        this.tone(bus, 300, now, 0.18, P.body, { gain: 0.6, slide: 1200 });
        this.noise(bus, now, 0.18, P.noise * 0.6, 3000, "bandpass");
        break;
      case "cancel":
        this.tone(bus, 660, now, 0.08, P.lead, { gain: 0.6 });
        this.tone(bus, 990, now + 0.05, 0.1, P.lead, { gain: 0.5 });
        break;
      case "garbageWarn":
        this.tone(bus, 440, now, 0.06, P.lead, { gain: 0.5 });
        this.tone(bus, 440, now + 0.12, 0.06, P.lead, { gain: 0.5 });
        break;
      case "garbageIn":
        this.tone(bus, 140, now, 0.18, P.body, { gain: 1, slide: 50 });
        this.noise(bus, now, 0.22, P.noise, 700);
        break;
      case "ko":
        this.tone(bus, 400, now, 0.4, P.body, { gain: 1, slide: 40 });
        this.noise(bus, now, 0.5, P.noise * 1.3, 1200);
        this.duck(0.3, 900);
        break;
      case "topOut":
        arp([67, 63, 60, 55], 0.12, 0.16, P.body);
        break;
      case "win":
        arp([72, 76, 79, 84, 79, 84, 88], 0.11, 0.18, P.lead, 1.1);
        this.duck(0.2, 1800);
        break;
      case "lose":
        arp([64, 60, 57, 52], 0.18, 0.25, P.body);
        break;
      case "count":
        this.tone(bus, 660, now, 0.08, P.lead, { gain: 0.8 });
        break;
      case "go":
        this.tone(bus, 990, now, 0.22, P.lead, { gain: 1 });
        break;
      case "click":
        this.tone(bus, 1400, now, 0.01, P.lead, { gain: 0.3 });
        break;
      case "join":
        arp([67, 72], 0.07, 0.08, P.lead, 0.7);
        break;
    }
  }

  // ---------------------------------------------------------------- music

  private startMusic(): void {
    if (!this.ctx || this.track === "off" || this.scheduler) return;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.scheduler = window.setInterval(() => this.schedule(), 25);
  }

  private stopMusic(): void {
    window.clearInterval(this.scheduler);
    this.scheduler = 0;
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || this.track === "off") return;
    const def = TRACKS[this.track];
    const bpm = def.bpm * (this.danger ? 1.06 : 1);
    const sixteenth = 60 / bpm / 4;
    while (this.nextTime < ctx.currentTime + 0.15) {
      this.playStep(def, this.step, this.nextTime, sixteenth);
      this.nextTime += sixteenth;
      this.step = (this.step + 1) % (def.bars.length * 16);
    }
  }

  private playStep(def: TrackDef, step: number, t: number, len: number): void {
    const bus = this.musicBus;
    const bar = def.bars[Math.floor(step / 16)]!;
    const s = step % 16;
    const v = (wave: OscillatorType, gain: number, release: number): Voice => ({ wave, attack: 0.01, release, gain });
    if (s === 0 || s === 6 || s === 10) this.tone(bus, midi(bar.bass), t, len * (s === 0 ? 5 : 3), v(def.timbre.bass, 0.28, 0.08));
    if (def.arp === "up8" && s % 2 === 0) {
      const n = bar.chord[(s / 2) % bar.chord.length]!;
      this.tone(bus, midi(n + 12), t, len * 1.4, v(def.timbre.arp, 0.07, 0.06));
    } else if (def.arp === "wave16") {
      const seq = [...bar.chord, ...bar.chord.slice(1, -1).reverse()];
      this.tone(bus, midi(seq[s % seq.length]! + 12), t, len * 1.6, v(def.timbre.arp, 0.08, 0.2));
    }
    const lead = def.lead[step];
    if (lead) this.tone(bus, midi(lead), t, len * 2.6, v(def.timbre.lead, 0.07, 0.15));
    if (def.kick.includes(s)) this.tone(bus, 120, t, 0.09, v("sine", 0.5, 0.05), { slide: 40 });
    if (def.snare.includes(s)) this.noise(bus, t, 0.12, 0.12, 2500, "bandpass");
    if (def.hat.includes(s) || (this.danger && s % 2 === 1)) this.noise(bus, t, 0.03, 0.05, 8000, "highpass");
  }
}

export const audio = new AudioEngine();

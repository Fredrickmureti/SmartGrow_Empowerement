/**
 * feedbackTones — operator-grade audio feedback pack for the mobile
 * scanner cockpit. Single shared AudioContext, lazy-resumed on first
 * user gesture (Safari/iOS WebAudio requirement).
 *
 * Tones:
 *   ok         — single 880 Hz square, 80 ms (confirmed scan)
 *   duplicate  — 440 Hz double-pulse, 60 ms x2 with 60 ms gap
 *   invalid    — 220 Hz long, 260 ms (unresolved / rejected)
 *   disconnect — 660 → 220 Hz descending sweep, 320 ms
 *
 * Mute state is persisted per-device in `localStorage["scanner.mute"]`.
 * Vibration is fired ONLY for `invalid` and `disconnect`; `ok` and
 * `duplicate` never vibrate so high-frequency scanning stays calm.
 */

const STORAGE_KEY = "scanner.mute";

export type ToneName = "ok" | "duplicate" | "invalid" | "disconnect";

let ctx: AudioContext | null = null;
let muted = readMutedFromStorage();
const listeners = new Set<(m: boolean) => void>();

function readMutedFromStorage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeMutedToStorage(value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* ignore quota / private mode */
  }
}

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC: typeof AudioContext | undefined =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    try {
      ctx = new AC();
    } catch {
      ctx = null;
    }
  }
  // Safari requires resume() after a user gesture.
  if (ctx && ctx.state === "suspended") {
    void ctx.resume().catch(() => undefined);
  }
  return ctx;
}

interface ToneStep {
  freq: number;
  durMs: number;
  /** Time to wait after the previous step before this one fires. */
  gapMs?: number;
  type?: OscillatorType;
  /** Linear ramp to this freq over the step's duration (for sweeps). */
  rampToFreq?: number;
}

const TONE_PROFILES: Record<ToneName, ToneStep[]> = {
  ok: [{ freq: 880, durMs: 80, type: "square" }],
  duplicate: [
    { freq: 440, durMs: 60, type: "square" },
    { freq: 440, durMs: 60, type: "square", gapMs: 60 },
  ],
  invalid: [{ freq: 220, durMs: 260, type: "sawtooth" }],
  disconnect: [{ freq: 660, durMs: 320, rampToFreq: 220, type: "sine" }],
};

const VIBRATE_FOR: Partial<Record<ToneName, number | number[]>> = {
  invalid: [80, 40, 80],
  disconnect: [120, 60, 120],
};

function scheduleStep(audio: AudioContext, step: ToneStep, startAt: number, gainValue = 0.22) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = step.type ?? "square";
  osc.frequency.setValueAtTime(step.freq, startAt);
  if (step.rampToFreq) {
    osc.frequency.linearRampToValueAtTime(step.rampToFreq, startAt + step.durMs / 1000);
  }
  // Quick attack + release to avoid clicks.
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(gainValue, startAt + 0.005);
  gain.gain.setValueAtTime(gainValue, startAt + step.durMs / 1000 - 0.01);
  gain.gain.linearRampToValueAtTime(0, startAt + step.durMs / 1000);
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start(startAt);
  osc.stop(startAt + step.durMs / 1000 + 0.02);
}

export const feedbackTones = {
  isMuted(): boolean {
    return muted;
  },
  setMuted(value: boolean): void {
    muted = value;
    writeMutedToStorage(value);
    for (const l of Array.from(listeners)) {
      try { l(value); } catch { /* ignore */ }
    }
  },
  toggleMuted(): boolean {
    feedbackTones.setMuted(!muted);
    return muted;
  },
  onMutedChange(listener: (m: boolean) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /**
   * Create/resume the AudioContext inside a user gesture (iOS Safari will
   * otherwise refuse to play the later, gesture-less scan tone).
   */
  unlock(): void {
    getCtx();
  },
  /** Fire the named tone. No-op when muted. */
  play(tone: ToneName): void {
    if (muted) return;
    const audio = getCtx();
    if (!audio) return;
    const profile = TONE_PROFILES[tone];
    let cursor = audio.currentTime;
    for (const step of profile) {
      cursor += (step.gapMs ?? 0) / 1000;
      try {
        scheduleStep(audio, step, cursor);
      } catch {
        /* WebAudio scheduling can throw on closed contexts — ignore. */
      }
      cursor += step.durMs / 1000;
    }
    const v = VIBRATE_FOR[tone];
    if (v !== undefined && typeof navigator !== "undefined" && "vibrate" in navigator) {
      try { navigator.vibrate(v); } catch { /* ignore */ }
    }
  },
  /** Test helper — reset the shared context + listeners. */
  _reset(): void {
    listeners.clear();
    if (ctx) {
      try { void ctx.close(); } catch { /* ignore */ }
    }
    ctx = null;
    muted = readMutedFromStorage();
  },
};

/** Map an ACK kind to the right tone — exported so consumers stay DRY. */
export function toneForAck(kind: "ok" | "weighted" | "unknown" | "error"): ToneName {
  if (kind === "ok" || kind === "weighted") return "ok";
  if (kind === "unknown") return "duplicate";
  return "invalid";
}

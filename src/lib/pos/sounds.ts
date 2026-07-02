/**
 * POS sound effects — synthesized via Web Audio API.
 *
 * No audio files are bundled or downloaded: every sound is generated on
 * demand from short oscillator envelopes. Bundle and network cost = 0.
 *
 * Preference (enabled / volume) is stored per-device in localStorage,
 * so it never touches the database. A tiny pub/sub keeps the header
 * toggle and settings card in sync, and `storage` events keep multiple
 * POS tabs on the same device consistent.
 */

export type POSSoundEvent =
  | "product_click"
  | "barcode_scan"
  | "payment_success"
  | "error"
  | "cart_remove"
  | "cart_clear"
  | "discount_applied"
  | "cash_drawer_open"
  | "manager_override"
  | "shift_open"
  | "shift_close"
  | "hold"
  | "recall"
  | "low_stock_warning"
  | "receipt_print";

const STORAGE_KEY = "pos.sound.prefs.v1";

export interface POSSoundPrefs {
  enabled: boolean;
  volume: number; // 0..1
}

const DEFAULT_PREFS: POSSoundPrefs = {
  enabled: true,
  volume: 0.4,
};

function readPrefs(): POSSoundPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<POSSoundPrefs>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_PREFS.enabled,
      volume:
        typeof parsed.volume === "number" && parsed.volume >= 0 && parsed.volume <= 1
          ? parsed.volume
          : DEFAULT_PREFS.volume,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

let cachedPrefs: POSSoundPrefs = readPrefs();
const listeners = new Set<(p: POSSoundPrefs) => void>();

export function getPOSSoundPrefs(): POSSoundPrefs {
  return cachedPrefs;
}

export function setPOSSoundPrefs(next: Partial<POSSoundPrefs>): POSSoundPrefs {
  cachedPrefs = { ...cachedPrefs, ...next };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedPrefs));
    } catch {
      /* private mode or quota — ignore */
    }
  }
  listeners.forEach((l) => l(cachedPrefs));
  return cachedPrefs;
}

export function subscribePOSSoundPrefs(cb: (p: POSSoundPrefs) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    cachedPrefs = readPrefs();
    listeners.forEach((l) => l(cachedPrefs));
  });
}

// ---------- Audio engine ----------

let audioCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (audioCtx && audioCtx.state !== "closed") return audioCtx;
  try {
    const w = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
    return audioCtx;
  } catch {
    return null;
  }
}

interface ToneSpec {
  freq: number;
  durationMs: number;
  type?: OscillatorType;
  startGain?: number; // peak gain before user volume multiplier
  delayMs?: number;
}

function playTones(tones: ToneSpec[]) {
  const prefs = cachedPrefs;
  if (!prefs.enabled || prefs.volume <= 0) return;
  const ctx = getCtx();
  if (!ctx) return;

  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  const now = ctx.currentTime;
  for (const tone of tones) {
    const start = now + (tone.delayMs ?? 0) / 1000;
    const dur = tone.durationMs / 1000;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = tone.type ?? "sine";
    osc.frequency.setValueAtTime(tone.freq, start);
    const peak = (tone.startGain ?? 0.6) * prefs.volume;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }
}

const RECIPES: Record<POSSoundEvent, ToneSpec[]> = {
  product_click: [
    { freq: 880, durationMs: 60, type: "sine", startGain: 0.35 },
  ],
  barcode_scan: [
    { freq: 1320, durationMs: 50, type: "square", startGain: 0.18 },
    { freq: 1760, durationMs: 70, type: "square", startGain: 0.18, delayMs: 55 },
  ],
  payment_success: [
    { freq: 880, durationMs: 140, type: "sine", startGain: 0.45 },
    { freq: 1318.5, durationMs: 220, type: "sine", startGain: 0.45, delayMs: 130 },
  ],
  error: [
    { freq: 220, durationMs: 120, type: "sawtooth", startGain: 0.3 },
    { freq: 165, durationMs: 180, type: "sawtooth", startGain: 0.3, delayMs: 110 },
  ],
  // Soft descending blip — the inverse of a product_click.
  cart_remove: [
    { freq: 660, durationMs: 55, type: "sine", startGain: 0.3 },
    { freq: 440, durationMs: 70, type: "sine", startGain: 0.3, delayMs: 50 },
  ],
  // "Swept" three-tone descent — heavier than a single remove.
  cart_clear: [
    { freq: 740, durationMs: 60, type: "triangle", startGain: 0.28 },
    { freq: 554, durationMs: 70, type: "triangle", startGain: 0.28, delayMs: 55 },
    { freq: 392, durationMs: 110, type: "triangle", startGain: 0.28, delayMs: 120 },
  ],
  // Bright two-step rise — "the price moved in the customer's favour".
  discount_applied: [
    { freq: 988, durationMs: 70, type: "sine", startGain: 0.32 },
    { freq: 1480, durationMs: 110, type: "sine", startGain: 0.32, delayMs: 65 },
  ],
  // Mechanical "ka-clack": a short low thud followed by a metallic pop.
  cash_drawer_open: [
    { freq: 140, durationMs: 70, type: "square", startGain: 0.32 },
    { freq: 1100, durationMs: 50, type: "square", startGain: 0.22, delayMs: 70 },
  ],
  // Authoritative two-tone confirmation, lower than payment_success.
  manager_override: [
    { freq: 660, durationMs: 110, type: "sine", startGain: 0.4 },
    { freq: 990, durationMs: 160, type: "sine", startGain: 0.4, delayMs: 105 },
  ],
  // "Ready" major triad — start of shift.
  shift_open: [
    { freq: 523.25, durationMs: 110, type: "sine", startGain: 0.35 },          // C5
    { freq: 659.25, durationMs: 110, type: "sine", startGain: 0.35, delayMs: 100 }, // E5
    { freq: 783.99, durationMs: 160, type: "sine", startGain: 0.35, delayMs: 200 }, // G5
  ],
  // Inverse triad — end of shift.
  shift_close: [
    { freq: 783.99, durationMs: 110, type: "sine", startGain: 0.35 },          // G5
    { freq: 659.25, durationMs: 110, type: "sine", startGain: 0.35, delayMs: 100 }, // E5
    { freq: 523.25, durationMs: 180, type: "sine", startGain: 0.35, delayMs: 200 }, // C5
  ],
  // Soft "set aside" — single muted triangle.
  hold: [
    { freq: 587.33, durationMs: 90, type: "triangle", startGain: 0.28 },       // D5
  ],
  // Inverse of hold — picked back up.
  recall: [
    { freq: 587.33, durationMs: 70, type: "triangle", startGain: 0.28 },       // D5
    { freq: 880, durationMs: 90, type: "triangle", startGain: 0.28, delayMs: 65 }, // A5
  ],
  // Two soft warning chirps — distinct from hard error (no sawtooth).
  low_stock_warning: [
    { freq: 740, durationMs: 80, type: "triangle", startGain: 0.3 },
    { freq: 740, durationMs: 80, type: "triangle", startGain: 0.3, delayMs: 130 },
  ],
  // Light paper-feed click; very short, low gain.
  receipt_print: [
    { freq: 1568, durationMs: 30, type: "square", startGain: 0.18 },
    { freq: 1568, durationMs: 30, type: "square", startGain: 0.18, delayMs: 45 },
    { freq: 1568, durationMs: 30, type: "square", startGain: 0.18, delayMs: 90 },
  ],
};

/** Play a POS sound. No-op when muted, when Web Audio is unavailable, or pre-gesture. */
export function playPOSSound(event: POSSoundEvent): void {
  const recipe = RECIPES[event];
  if (!recipe) return;
  playTones(recipe);
}

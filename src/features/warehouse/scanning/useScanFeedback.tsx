/**
 * useScanFeedback — Phase 4 §4.
 *
 * One hook for every operator-facing scan reaction: audio tone, haptic
 * pulse, and a full-screen colour flash. RF/headset users work with gloves
 * and eyes on the pallet, so a scan result must be perceivable without
 * reading the screen.
 *
 * Single source of truth: no page may hand-roll a `beep()` or a
 * `navigator.vibrate` call — the phase-4 guard pins that.
 *
 * Everything degrades safely: Web Audio is created lazily on first use
 * (so it is inside the user-gesture that produced the scan), vibration is
 * feature-detected, and the flash is a purely visual overlay.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

export type ScanOutcome = "success" | "error" | "warn";

const TONES: Record<ScanOutcome, { freq: number[]; ms: number }> = {
  success: { freq: [880, 1320], ms: 90 },
  warn: { freq: [660], ms: 160 },
  error: { freq: [220, 165], ms: 200 },
};

const HAPTICS: Record<ScanOutcome, number | number[]> = {
  success: 35,
  warn: [40, 60, 40],
  error: [80, 70, 80],
};

const FLASH_CLASS: Record<ScanOutcome, string> = {
  success: "bg-success/30",
  warn: "bg-warning/30",
  error: "bg-destructive/30",
};

const MUTE_KEY = "wms_scan_feedback_muted";

let audioCtx: AudioContext | null = null;
function ctx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  if (audioCtx.state === "suspended") void audioCtx.resume();
  return audioCtx;
}

function playTone(outcome: ScanOutcome) {
  const ac = ctx();
  if (!ac) return;
  const { freq, ms } = TONES[outcome];
  freq.forEach((f, i) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "square";
    osc.frequency.value = f;
    // Keep it quiet enough for a shift-long exposure.
    gain.gain.value = 0.06;
    osc.connect(gain).connect(ac.destination);
    const start = ac.currentTime + (i * ms) / 1000;
    osc.start(start);
    osc.stop(start + ms / 1000);
  });
}

function vibrate(outcome: ScanOutcome) {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(HAPTICS[outcome]);
  } catch {
    /* vibration is best-effort */
  }
}

export interface ScanFeedback {
  /** Fire audio + haptics + flash for a scan outcome. */
  signal: (outcome: ScanOutcome) => void;
  /** Convenience wrappers. */
  success: () => void;
  warn: () => void;
  error: () => void;
  /** Render this inside the screen to get the colour flash. */
  Flash: () => ReactElement | null;
  muted: boolean;
  setMuted: (m: boolean) => void;
}

export function useScanFeedback(): ScanFeedback {
  const [flash, setFlash] = useState<ScanOutcome | null>(null);
  const [muted, setMutedState] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    setMutedState(localStorage.getItem(MUTE_KEY) === "1");
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    if (typeof localStorage !== "undefined") localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  }, []);

  const signal = useCallback(
    (outcome: ScanOutcome) => {
      if (!muted) playTone(outcome);
      vibrate(outcome);
      setFlash(outcome);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setFlash(null), 260);
    },
    [muted],
  );

  const Flash = useCallback(() => {
    if (!flash) return null;
    return (
      <div
        aria-hidden
        className={`pointer-events-none fixed inset-0 z-[60] animate-fade-in ${FLASH_CLASS[flash]}`}
      />
    );
  }, [flash]);

  return {
    signal,
    success: useCallback(() => signal("success"), [signal]),
    warn: useCallback(() => signal("warn"), [signal]),
    error: useCallback(() => signal("error"), [signal]),
    Flash,
    muted,
    setMuted,
  };
}

/* ------------------------------------------------------------------
 * Global bridge
 *
 * Non-React code (the offline queue) is the place that actually learns
 * whether a scan committed, was queued, or was rejected. Rather than
 * threading callbacks through eight screens — which drifts the moment
 * someone adds a ninth — the queue emits an outcome here and the mobile
 * layout subscribes once, so feedback is uniform by construction.
 * ------------------------------------------------------------------ */
type Listener = (outcome: ScanOutcome) => void;
const listeners = new Set<Listener>();

/** Called by the offline queue after every enqueue/drain result. */
export function emitScanOutcome(outcome: ScanOutcome): void {
  listeners.forEach((l) => {
    try {
      l(outcome);
    } catch {
      /* a bad listener must never break the scan path */
    }
  });
}

/**
 * Mount once (in the mobile layout): subscribes to `emitScanOutcome` and
 * returns the overlay to render.
 */
export function useScanFeedbackBridge(): ScanFeedback {
  const fb = useScanFeedback();
  const signalRef = useRef(fb.signal);
  signalRef.current = fb.signal;

  useEffect(() => {
    const listener: Listener = (o) => signalRef.current(o);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return fb;
}

export default useScanFeedback;

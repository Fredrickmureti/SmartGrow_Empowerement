/**
 * deviceMode — is THIS device a handheld (the ERP runs on it and its own
 * camera is the scanner) or a workstation (the scanner is a paired phone
 * or a USB gun)?
 *
 * The modes are not exclusive: a handheld may still be paired as a
 * companion, and a workstation may still accept a paired phone. The mode
 * only decides whether the local-camera affordance is offered, so an
 * operator on a phone never has to find a PC to scan into a field.
 *
 * Auto-detection: handheld when the device exposes a camera AND the
 * primary pointer is coarse (touch). Operators can override; the override
 * is persisted per device in localStorage.
 */

export type ScannerDeviceMode = "handheld" | "workstation";
export type ScannerDeviceModePreference = ScannerDeviceMode | "auto";

const STORAGE_KEY = "scanner.deviceMode";

const listeners = new Set<(p: ScannerDeviceModePreference) => void>();
let preference: ScannerDeviceModePreference | null = null;

function readPreference(): ScannerDeviceModePreference {
  if (preference) return preference;
  if (typeof window === "undefined") return "auto";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    preference = raw === "handheld" || raw === "workstation" ? raw : "auto";
  } catch {
    preference = "auto";
  }
  return preference;
}

/** True when the browser can plausibly open a rear camera. */
export function hasCamera(): boolean {
  if (typeof navigator === "undefined") return false;
  return typeof navigator.mediaDevices?.getUserMedia === "function";
}

function isCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/** Mode we would pick with no operator override. */
export function detectDeviceMode(): ScannerDeviceMode {
  return hasCamera() && isCoarsePointer() ? "handheld" : "workstation";
}

export const scannerDeviceMode = {
  /** Raw preference including "auto". */
  getPreference(): ScannerDeviceModePreference {
    return readPreference();
  },
  /** Effective mode after applying the preference. */
  get(): ScannerDeviceMode {
    const pref = readPreference();
    return pref === "auto" ? detectDeviceMode() : pref;
  },
  set(next: ScannerDeviceModePreference): void {
    preference = next;
    if (typeof window !== "undefined") {
      try {
        if (next === "auto") window.localStorage.removeItem(STORAGE_KEY);
        else window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* private mode / quota — in-memory only */
      }
    }
    for (const l of Array.from(listeners)) {
      try { l(next); } catch { /* ignore */ }
    }
  },
  subscribe(listener: (p: ScannerDeviceModePreference) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Test helper. */
  _reset(): void {
    preference = null;
    listeners.clear();
  },
};

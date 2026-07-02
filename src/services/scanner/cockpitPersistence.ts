/**
 * cockpitPersistence — sessionStorage-backed snapshot of the phone-side
 * cockpit (recent rail + counters) keyed by the active pairing session.
 *
 * Survives refresh / accidental tab reloads inside the same browsing
 * session; dropped on tab close (sessionStorage scope) — which is the
 * right behaviour for PII-light operational state.
 *
 * Schema is versioned. Mismatched / corrupt payloads rehydrate as null
 * so the cockpit starts clean instead of crashing.
 */

const VERSION = 1 as const;
const KEY_PREFIX = "pos.scanner.cockpit.";

export interface CockpitRow {
  id: number;
  code: string;
  kind: "pending" | "ok" | "weighted" | "unknown" | "error";
  detail?: string | null;
  symbology?: string | null;
  at: number;
}

export interface CockpitSnapshot {
  v: typeof VERSION;
  recent: CockpitRow[];
  scanCount: number;
  scanTimestamps: number[];
  latencySamples: number[];
  nextId: number;
  savedAt: number;
}

export function cockpitKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

export function saveCockpit(sessionId: string, snap: Omit<CockpitSnapshot, "v" | "savedAt">): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    const payload: CockpitSnapshot = { v: VERSION, savedAt: Date.now(), ...snap };
    // Cap aggressively to avoid hitting the ~5MB quota.
    payload.recent = payload.recent.slice(0, 50);
    payload.scanTimestamps = payload.scanTimestamps.slice(-500);
    payload.latencySamples = payload.latencySamples.slice(-200);
    sessionStorage.setItem(cockpitKey(sessionId), JSON.stringify(payload));
  } catch {
    /* quota / serialization — ignore, persistence is best-effort */
  }
}

export function loadCockpit(sessionId: string): CockpitSnapshot | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(cockpitKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CockpitSnapshot;
    if (!parsed || parsed.v !== VERSION || !Array.isArray(parsed.recent)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearCockpit(sessionId: string): void {
  if (typeof sessionStorage === "undefined") return;
  try { sessionStorage.removeItem(cockpitKey(sessionId)); } catch { /* ignore */ }
}

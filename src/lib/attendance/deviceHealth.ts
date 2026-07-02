/**
 * deviceHealth — derives a tone + label for an attendance device based on
 * how recently it pinged the ingest endpoint. Shared by the devices table
 * and the inbox card so the rules don't drift.
 */

export type DeviceHealth = {
  tone: "ok" | "warn" | "stale" | "never";
  label: string;
  ageMs: number | null;
};

const FIVE_MIN = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

export function deviceHealth(lastSeenAt: string | null): DeviceHealth {
  if (!lastSeenAt) return { tone: "never", label: "Never", ageMs: null };
  const age = Date.now() - new Date(lastSeenAt).getTime();
  if (age < FIVE_MIN) return { tone: "ok", label: "Online", ageMs: age };
  if (age < ONE_HOUR) return { tone: "warn", label: "Idle", ageMs: age };
  if (age < ONE_DAY) return { tone: "warn", label: "Quiet", ageMs: age };
  return { tone: "stale", label: "Silent", ageMs: age };
}

export function isDeviceStale(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return true;
  return Date.now() - new Date(lastSeenAt).getTime() >= ONE_DAY;
}

export const deviceHealthBadgeClass: Record<DeviceHealth["tone"], string> = {
  ok: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  stale: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
  never: "bg-muted text-muted-foreground border-border",
};

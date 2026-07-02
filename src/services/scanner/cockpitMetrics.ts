/**
 * cockpitMetrics — pure helpers for the phone-side operational cockpit.
 *
 * The phone needs to surface three numbers an operator can read at
 * arm's-length without leaving the camera view:
 *
 *   1. Session uptime — monotonic mm:ss since the channel last
 *      transitioned to SUBSCRIBED.
 *   2. Scans/min — rolling 60 s rate of broadcasts the phone successfully
 *      pushed (excludes pending queue items, includes camera + manual).
 *   3. Median ACK latency — median over the last `LATENCY_WINDOW`
 *      (`decoded_at → ack.at`) samples.
 *
 * Pure — no React, no Supabase. Unit-tested in
 * `src/test/scanner/cockpit-metrics.test.ts`.
 */

export const SCANS_PER_MIN_WINDOW_MS = 60_000;
export const LATENCY_WINDOW = 20;

export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Count timestamps falling inside the rolling 60 s window ending at `now`.
 * `timestamps` may include older entries — the caller does not have to
 * trim them. Returns the count, NOT a per-minute extrapolation, so a
 * 30-second-old session reads "3 scans" instead of "6 scans/min" that
 * the operator would mentally distrust.
 */
export function scansInLastMinute(timestamps: number[], now: number): number {
  const cutoff = now - SCANS_PER_MIN_WINDOW_MS;
  let count = 0;
  for (const t of timestamps) {
    if (t >= cutoff) count++;
  }
  return count;
}

export function appendLatencySample(samples: number[], rttMs: number): number[] {
  if (!Number.isFinite(rttMs) || rttMs < 0) return samples;
  const next = samples.length >= LATENCY_WINDOW ? samples.slice(1) : samples.slice();
  next.push(rttMs);
  return next;
}

export function medianLatency(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

export interface CockpitMetrics {
  uptimeMs: number;
  uptimeLabel: string;
  scansLastMin: number;
  medianLatencyMs: number | null;
}

export function deriveCockpitMetrics(args: {
  subscribedAt: number | null;
  scanTimestamps: number[];
  latencySamples: number[];
  now: number;
}): CockpitMetrics {
  const uptimeMs = args.subscribedAt ? Math.max(0, args.now - args.subscribedAt) : 0;
  return {
    uptimeMs,
    uptimeLabel: formatUptime(uptimeMs),
    scansLastMin: scansInLastMinute(args.scanTimestamps, args.now),
    medianLatencyMs: medianLatency(args.latencySamples),
  };
}
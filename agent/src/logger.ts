/**
 * Structured NDJSON logger + in-memory ring buffer.
 *
 * Phase 1 of AccrualFlow Edge: replaces ad-hoc `console.log` so that
 * operators can retrieve logs from the /health and /support-bundle
 * endpoints, and later from the desktop shell, without shell access.
 *
 * - Emits one JSON object per line to stdout.
 * - Keeps the last N entries in memory for the support bundle.
 * - Never logs secrets (tokens, request bodies).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  ctx?: Record<string, unknown>;
}

const RING_CAPACITY = 500;
const ring: LogEntry[] = [];

function emit(entry: LogEntry) {
  ring.push(entry);
  if (ring.length > RING_CAPACITY) ring.shift();
  // NDJSON to stdout
  try {
    process.stdout.write(JSON.stringify(entry) + '\n');
  } catch {
    // best-effort
  }
}

function log(level: LogLevel, msg: string, ctx?: Record<string, unknown>) {
  emit({ ts: new Date().toISOString(), level, msg, ctx });
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => log('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => log('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => log('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => log('error', msg, ctx),
};

/** Snapshot the recent-log ring buffer (newest last). */
export function recentLogs(): LogEntry[] {
  return ring.slice();
}

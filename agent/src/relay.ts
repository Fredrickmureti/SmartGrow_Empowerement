/**
 * AccrualFlow Edge — Phase 2 relay subscriber.
 *
 * When a `workstation.json` config is present at:
 *
 *   $ACCRUALFLOW_EDGE_CONFIG          (explicit override)
 *   ~/.accrualflow/edge/workstation.json  (default)
 *
 * this module polls the `edge-agent-poll` edge function for queued jobs,
 * dispatches each job to the matching local route handler, and posts the
 * result back via `edge-agent-complete`. The workstation authenticates
 * with a bearer secret issued by `edge-workstation-register`; the raw
 * secret never leaves the workstation and is never sent to any browser.
 *
 * Config file shape:
 * {
 *   "supabase_url": "https://<ref>.supabase.co",
 *   "workstation_id": "<uuid>",
 *   "workstation_secret": "<raw secret>"
 * }
 *
 * The subscriber is intentionally polling-based for Phase 2: it works
 * behind every corporate proxy, needs zero extra dependencies (Node's
 * global fetch is enough), and gives us a clean seam to swap in a
 * long-lived WebSocket in Phase 4 when the desktop shell lands.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from './logger.js';
import { setRelayHealth } from './relay-state.js';

const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, ctx: Record<string, unknown>) =>
  logger[level](msg, ctx);

export interface RelayConfig {
  supabase_url: string;
  workstation_id: string;
  workstation_secret: string;
}

export const AGENT_VERSION = '1.3.0-edge.p3';

interface RelayJob {
  id: string;
  role: string;
  op: string;
  payload: Record<string, unknown> | null;
  idempotency_key: string | null;
  deadline_at: string;
  created_at: string;
}

const POLL_INTERVAL_MS = 1_500;
const POLL_ERROR_BACKOFF_MS = 15_000;
/**
 * A 401 means the workstation secret on disk no longer matches the server
 * (almost always because the operator just rotated it in the desktop app).
 * That is recoverable within seconds by re-reading the config file, so it
 * gets a short backoff instead of the generic network backoff.
 */
const AUTH_ERROR_BACKOFF_MS = 3_000;

export type RelayHandler = (job: RelayJob) => Promise<{ success: boolean; result?: unknown; error?: string }>;

export function configPath(): string {
  const explicit = process.env.ACCRUALFLOW_EDGE_CONFIG;
  return explicit && explicit.length > 0
    ? explicit
    : join(homedir(), '.accrualflow', 'edge', 'workstation.json');
}

export function loadConfig(): RelayConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RelayConfig>;
    if (!parsed.supabase_url || !parsed.workstation_id || !parsed.workstation_secret) {
      log('warn', 'relay.config.invalid', { path });
      return null;
    }
    return parsed as RelayConfig;
  } catch (err) {
    log('warn', 'relay.config.read_failed', { path, error: String(err) });
    return null;
  }
}

function configMtimeMs(): number {
  try { return statSync(configPath()).mtimeMs; } catch { return 0; }
}

function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('poll_http_401') || msg.includes('poll_http_404');
}

async function pollOnce(cfg: RelayConfig): Promise<RelayJob[]> {
  const res = await fetch(`${cfg.supabase_url}/functions/v1/edge/agent/poll`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.workstation_secret}`,
      'X-Workstation-Id': cfg.workstation_id,
    },
    body: JSON.stringify({ version: AGENT_VERSION }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`poll_http_${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json() as { job?: RelayJob | null; jobs?: RelayJob[] };
  // Batch-capable server returns `jobs`; fall back to the single-job shape.
  if (Array.isArray(data.jobs) && data.jobs.length > 0) return data.jobs;
  return data.job ? [data.job] : [];
}

async function complete(
  cfg: RelayConfig,
  jobId: string,
  outcome: { success: boolean; result?: unknown; error?: string },
): Promise<void> {
  const res = await fetch(`${cfg.supabase_url}/functions/v1/edge/agent/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.workstation_secret}`,
      'X-Workstation-Id': cfg.workstation_id,
    },
    body: JSON.stringify({ job_id: jobId, ...outcome }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    log('error', 'relay.complete.failed', { jobId, status: res.status, body: body.slice(0, 200) });
  }
}

/**
 * Start the relay loop. Returns a stop function; if no config is present,
 * returns a no-op and logs once so the operator can see why the relay is
 * inactive.
 */
/** Agent-side timing, mirrored into the browser's print trace. */
export interface AgentSpan {
  name: string;
  durationMs: number;
  ok: boolean;
  attributes?: Record<string, string | number | boolean | null>;
}

/**
 * Merge agent spans into the job result under `_agent_spans`.
 *
 * They ride inside `result` rather than as a sibling field because that is
 * the only part of the completion payload the browser is guaranteed to read
 * back off `edge_jobs`. Route-level spans (printer queue wait, socket time)
 * already present in the result are preserved and prefixed by the relay's.
 */
export function attachAgentSpans(
  outcome: { success: boolean; result?: unknown; error?: string },
  spans: AgentSpan[],
): { success: boolean; result?: unknown; error?: string } {
  const base = outcome.result;
  const isPlain = base !== null && typeof base === 'object' && !Array.isArray(base);
  const inner = isPlain ? (base as Record<string, unknown>) : {};
  const routeSpans = Array.isArray(inner.spans) ? (inner.spans as AgentSpan[]) : [];
  const merged = [...spans, ...routeSpans];
  const result: Record<string, unknown> = isPlain ? { ...inner } : { value: base ?? null };
  delete result.spans;
  result._agent_spans = merged;
  return { ...outcome, result };
}

export function startRelay(handler: RelayHandler): () => void {
  let cfg = loadConfig();
  let mtime = configMtimeMs();
  let reloads = 0;

  if (!cfg) {
    // No credential *yet* — the operator may enrol at any moment from the
    // desktop shell. Keep watching the config path instead of giving up for
    // the lifetime of the process (which previously required a restart).
    log('info', 'relay.inactive.no_config', { path: configPath() });
  }
  setRelayHealth({
    state: cfg ? 'starting' : 'inactive',
    workstationId: cfg?.workstation_id ?? null,
    lastError: null,
    consecutiveErrors: 0,
    credentialReloads: 0,
  });

  let stopped = false;
  if (cfg) log('info', 'relay.started', { workstationId: cfg.workstation_id, supabaseUrl: cfg.supabase_url });

  /** Re-read `workstation.json`; returns true when the credential changed. */
  const reloadConfig = (reason: string): boolean => {
    const next = loadConfig();
    mtime = configMtimeMs();
    const changed = Boolean(next) && (
      !cfg
      || next!.workstation_secret !== cfg.workstation_secret
      || next!.workstation_id !== cfg.workstation_id
      || next!.supabase_url !== cfg.supabase_url
    );
    if (changed) {
      cfg = next;
      reloads += 1;
      log('info', 'relay.credential.reloaded', { reason, workstationId: cfg!.workstation_id, reloads });
      setRelayHealth({ workstationId: cfg!.workstation_id, credentialReloads: reloads });
    }
    return changed;
  };

  const loop = async () => {
    while (!stopped) {
      // Pick up an enrolment / rotation that happened while we were running.
      if (!cfg || configMtimeMs() !== mtime) reloadConfig(cfg ? 'mtime_changed' : 'awaiting_enrolment');
      if (!cfg) {
        setRelayHealth({ state: 'inactive' });
        await sleep(POLL_INTERVAL_MS * 2);
        continue;
      }
      const active = cfg;
      try {
        const batch = await pollOnce(active);
        setRelayHealth({
          state: 'ok',
          workstationId: active.workstation_id,
          lastPollOkAt: new Date().toISOString(),
          lastError: null,
          consecutiveErrors: 0,
        });
        if (batch.length === 0) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        // Drain the whole claimed batch sequentially — no extra poll round-trip
        // between jobs, which is what used to let bursts expire mid-queue.
        if (batch.length > 1) log('info', 'relay.batch.received', { count: batch.length });
        for (const job of batch) {
          if (stopped) break;
          log('info', 'relay.job.received', { jobId: job.id, role: job.role, op: job.op });
          // Never execute a job whose deadline already passed. The browser has
          // long since given up, so physically printing it now would be a
          // "ghost print" arriving minutes after the operator asked for it.
          const deadlineMs = Date.parse(job.deadline_at);
          if (Number.isFinite(deadlineMs) && deadlineMs < Date.now()) {
            const lateBy = Math.round((Date.now() - deadlineMs) / 1000);
            const ageMs = Date.now() - Date.parse(job.created_at);
            log('warn', 'relay.job.expired_before_run', {
              jobId: job.id,
              op: job.op,
              role: job.role,
              lateBySeconds: lateBy,
              jobAgeMs: Number.isFinite(ageMs) ? ageMs : null,
            });
            await complete(active, job.id, {
              success: false,
              error: `expired_before_run: deadline passed ${lateBy}s ago`,
            });
            continue;
          }
          let outcome: { success: boolean; result?: unknown; error?: string };
          const startedAt = Date.now();
          const queuedMs = Number.isFinite(Date.parse(job.created_at))
            ? startedAt - Date.parse(job.created_at)
            : null;
          try {
            outcome = await handler(job);
          } catch (err) {
            outcome = { success: false, error: err instanceof Error ? err.message : String(err) };
          }
          // Feed the agent's own timings back to the browser waterfall. The
          // relay hop is otherwise a single opaque `relay.agent_roundtrip`
          // bar, which is where most "the print was slow" reports die.
          outcome = attachAgentSpans(outcome, [
            ...(queuedMs !== null
              ? [{ name: 'agent.relay_queue_wait', durationMs: queuedMs, ok: true }]
              : []),
            {
              name: 'agent.handler',
              durationMs: Date.now() - startedAt,
              ok: outcome.success,
              attributes: { role: job.role, op: job.op },
            },
          ]);
          await complete(active, job.id, outcome);
          log('info', 'relay.job.completed', {
            jobId: job.id,
            success: outcome.success,
            elapsedMs: Date.now() - startedAt,
          });
        }
        // Immediately loop to drain any queued burst.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const auth = isAuthError(err);
        log('warn', 'relay.poll.error', { error: message, auth });
        setRelayHealth({
          state: auth ? 'unauthorized' : 'error',
          lastError: message,
          consecutiveErrors: (auth ? 1 : 1),
        });
        if (auth) {
          // Self-heal: the desktop app rewrites workstation.json on rotation,
          // so re-read it and retry quickly rather than backing off for 15 s
          // and never recovering until restart.
          const changed = reloadConfig('auth_error');
          await sleep(changed ? 250 : AUTH_ERROR_BACKOFF_MS);
        } else {
          await sleep(POLL_ERROR_BACKOFF_MS);
        }
      }
    }
    setRelayHealth({ state: 'inactive' });
  };

  void loop();
  return () => { stopped = true; };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

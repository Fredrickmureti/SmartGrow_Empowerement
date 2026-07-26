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

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from './logger.js';

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

export type RelayHandler = (job: RelayJob) => Promise<{ success: boolean; result?: unknown; error?: string }>;

export function loadConfig(): RelayConfig | null {
  const explicit = process.env.ACCRUALFLOW_EDGE_CONFIG;
  const path = explicit && explicit.length > 0
    ? explicit
    : join(homedir(), '.accrualflow', 'edge', 'workstation.json');
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

async function pollOnce(cfg: RelayConfig): Promise<RelayJob | null> {
  const res = await fetch(`${cfg.supabase_url}/functions/v1/edge-agent-poll`, {
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
  const data = await res.json() as { job: RelayJob | null };
  return data.job ?? null;
}

async function complete(
  cfg: RelayConfig,
  jobId: string,
  outcome: { success: boolean; result?: unknown; error?: string },
): Promise<void> {
  const res = await fetch(`${cfg.supabase_url}/functions/v1/edge-agent-complete`, {
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
export function startRelay(handler: RelayHandler): () => void {
  const cfg = loadConfig();
  if (!cfg) {
    log('info', 'relay.inactive.no_config', {});
    return () => undefined;
  }

  let stopped = false;
  log('info', 'relay.started', { workstationId: cfg.workstation_id, supabaseUrl: cfg.supabase_url });

  const loop = async () => {
    while (!stopped) {
      try {
        const job = await pollOnce(cfg);
        if (!job) {
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        log('info', 'relay.job.received', { jobId: job.id, role: job.role, op: job.op });
        let outcome: { success: boolean; result?: unknown; error?: string };
        try {
          outcome = await handler(job);
        } catch (err) {
          outcome = { success: false, error: err instanceof Error ? err.message : String(err) };
        }
        await complete(cfg, job.id, outcome);
        log('info', 'relay.job.completed', { jobId: job.id, success: outcome.success });
        // Immediately loop to drain any queued burst.
      } catch (err) {
        log('warn', 'relay.poll.error', { error: err instanceof Error ? err.message : String(err) });
        await sleep(POLL_ERROR_BACKOFF_MS);
      }
    }
  };

  void loop();
  return () => { stopped = true; };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

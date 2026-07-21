/**
 * SharedCommandQueueWorker — drains `hardware_command_queue`.
 *
 * The queue holds hardware commands that need to be executed on a
 * physical device shared across browser tabs / Electron hosts (e.g. a
 * single receipt printer on the front counter that two cashiers'
 * browsers both reach). Without a worker, the schema sits unused.
 *
 * Liveness contract:
 *   - Claim with `claim_next_hardware_command(org, worker_id, limit, branch)`
 *     which atomically marks the row `running` under FOR UPDATE SKIP
 *     LOCKED and stamps `claimed_at` + `claimed_by`. The RPC also has a
 *     5-arg overload accepting `p_device_assignment_id` (Wave B4.1) so a
 *     specialised worker can serialize claims to a single device — we
 *     don't use it here because this worker dispatches one row at a time
 *     and the AgentClient already enforces per-endpoint FIFO inside the
 *     tab (Wave B4.2). The DB lock matters once we run multi-claim
 *     (`p_limit > 1`) or multiple workers per branch.
 *   - Dispatch via `hardwareClient.exec`, then `complete_hardware_command`.
 *   - If a host dies mid-dispatch, the lease expires and the periodic
 *     `reclaim_stale_hardware_commands()` RPC re-queues the row.
 *   - Multi-tab cashiers elect one leader per browser via
 *     `BroadcastChannel` so we don't double-dispatch from the same
 *     machine. Other tabs join as observers and take over if the
 *     leader's heartbeat stops.
 *
 * This module is intentionally framework-agnostic — `BusinessSagaMount`
 * calls `startSharedCommandQueueWorker(orgId)` on mount and stop on
 * unmount.
 */
import { supabase } from '@/integrations/supabase/client';
import { hardwareClient } from './HardwareClient';
import type { DeviceRole } from './drivers/DriverInterface';

/** ADR-0090 · Phase D2 — roles whose ack is mirrored into `print_jobs`. */
const PRINT_ROLES = new Set<string>([
  'receipt_printer', 'kitchen_printer', 'label_printer', 'a4_printer',
]);
function isPrintRole(role: string): boolean {
  return PRINT_ROLES.has(role);
}

/**
 * ADR-0090 · Phase D2 — flip the ledger row keyed by hw_command_id to
 * `failed` with an error. There is no by-hw-id failure RPC (mark_failed
 * expects the job id), so we look up the job id via a direct read
 * against the RLS-protected `print_jobs` table, then call mark_failed.
 */
async function markJobFailedByHwId(hwCommandId: number, error: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('print_jobs')
      .select('id')
      .eq('hw_command_id', hwCommandId)
      .in('status', ['queued', 'sent'])
      .maybeSingle();
    const jobId = (data as { id?: string } | null)?.id;
    if (!jobId) return;
    await supabase.rpc('print_job_mark_failed', { p_id: jobId, p_error: error });
  } catch { /* noop */ }
}

const POLL_INTERVAL_MS = 3_000;
const RECLAIM_INTERVAL_MS = 60_000;
const LEADER_HEARTBEAT_MS = 5_000;
const LEADER_TAKEOVER_MS = 12_000;

interface QueueRow {
  id: number;
  org_id: string;
  business_id?: string | null;
  branch_id: string | null;
  role: string;
  op: string;
  payload: unknown;
  idempotency_key: string | null;
  business_event_id: string | null;
  source_doc_type: string | null;
  source_doc_id: string | null;
}

export interface WorkerStatus {
  workerId: string;
  isLeader: boolean;
  lastClaimAt: number | null;
  inFlight: { id: number; role: string; op: string } | null;
  totalCompleted: number;
  totalFailed: number;
  totalReclaimed: number;
  startedAt: number;
}

let active: { stop: () => void; status: () => WorkerStatus } | null = null;

export function getWorkerStatus(): WorkerStatus | null {
  return active?.status() ?? null;
}

export function startSharedCommandQueueWorker(
  orgId: string,
  branchId?: string | null,
): () => void {
  if (active) active.stop();

  const workerId = `worker:${Math.random().toString(36).slice(2, 10)}:${Date.now()}`;
  const status: WorkerStatus = {
    workerId,
    isLeader: false,
    lastClaimAt: null,
    inFlight: null,
    totalCompleted: 0,
    totalFailed: 0,
    totalReclaimed: 0,
    startedAt: Date.now(),
  };

  // ── Leader election via BroadcastChannel (browser-tab scope) ──────
  const channelName = `hw-cmd-queue:${orgId}:${branchId ?? 'all'}`;
  let channel: BroadcastChannel | null = null;
  let lastPeerHeartbeat = 0;
  let leaderTimer: ReturnType<typeof setInterval> | null = null;

  try {
    channel = new BroadcastChannel(channelName);
    channel.onmessage = (ev) => {
      const msg = ev.data as { type: string; workerId: string; at: number };
      if (!msg) return;
      if (msg.type === 'heartbeat' && msg.workerId !== workerId) {
        // If a peer with a "smaller" id is alive, defer to it.
        if (msg.workerId < workerId) {
          status.isLeader = false;
          lastPeerHeartbeat = msg.at;
        }
      }
    };
  } catch { /* no BroadcastChannel (SSR / old browser) — assume sole leader */ }

  function tryAssumeLeadership() {
    if (!channel) { status.isLeader = true; return; }
    const now = Date.now();
    if (now - lastPeerHeartbeat > LEADER_TAKEOVER_MS) {
      status.isLeader = true;
    }
    if (status.isLeader) {
      try { channel.postMessage({ type: 'heartbeat', workerId, at: now }); } catch { /* */ }
    }
  }

  leaderTimer = setInterval(tryAssumeLeadership, LEADER_HEARTBEAT_MS);
  tryAssumeLeadership();

  // ── Reclaim stale leases (everybody runs this, RPC is idempotent) ─
  const reclaimTimer = setInterval(async () => {
    try {
      const { data } = await supabase.rpc('reclaim_stale_hardware_commands');
      if (Array.isArray(data) && data.length > 0) {
        status.totalReclaimed += data.length;
      }
    } catch { /* swallow */ }
  }, RECLAIM_INTERVAL_MS);

  // ── Poll loop ─────────────────────────────────────────────────────
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  async function pollOnce() {
    if (stopped || !status.isLeader) return;
    try {
      const { data, error } = await supabase.rpc('claim_next_hardware_command', {
        p_org_id: orgId,
        p_claimant: workerId,
        p_limit: 1,
        p_branch_id: branchId ?? null,
      });
      if (error || !Array.isArray(data) || data.length === 0) return;
      for (const row of data as QueueRow[]) {
        status.lastClaimAt = Date.now();
        status.inFlight = { id: row.id, role: row.role, op: row.op };
        try {
          const result = await hardwareClient.exec({
            role: row.role as DeviceRole,
            op: row.op,
            payload: row.payload,
            idempotencyKey: row.idempotency_key ?? undefined,
            sourceDocType: row.source_doc_type,
            sourceDocId: row.source_doc_id,
            businessEventId: row.business_event_id,
          });
          await supabase.rpc('complete_hardware_command', {
            p_id: row.id,
            p_success: !!result?.success,
            p_error: result?.success ? null : (result?.error ?? 'unknown'),
          });
          // ADR-0090 · Phase D2 — mirror the driver ack into the print
          // job ledger so the Print Queue UI reflects delivery, not just
          // dispatch. Only fires for print roles; other roles (drawer,
          // scale) never populate print_jobs.
          if (isPrintRole(row.role)) {
            try {
              if (result?.success) {
                await supabase.rpc('print_job_mark_acked', { p_hw_command_id: row.id });
              } else {
                // No job id here — mark_failed is keyed by job id. Use a
                // dedicated by-hw-id failure RPC path via mark_acked's
                // sibling call is impossible; we run an update through the
                // failed RPC indirectly by matching on hw_command_id below.
                await markJobFailedByHwId(row.id, result?.error ?? 'driver reported failure');
              }
            } catch { /* ledger failures never block queue */ }
          }
          if (result?.success) status.totalCompleted += 1;
          else status.totalFailed += 1;
        } catch (err) {
          status.totalFailed += 1;
          try {
            await supabase.rpc('complete_hardware_command', {
              p_id: row.id,
              p_success: false,
              p_error: err instanceof Error ? err.message : String(err),
            });
            if (isPrintRole(row.role)) {
              await markJobFailedByHwId(row.id, err instanceof Error ? err.message : String(err));
            }
          } catch { /* swallow */ }
        } finally {
          status.inFlight = null;
        }
      }
    } catch { /* swallow — next tick will retry */ }
  }

  function scheduleNext() {
    if (stopped) return;
    pollTimer = setTimeout(async () => {
      await pollOnce();
      scheduleNext();
    }, POLL_INTERVAL_MS);
  }
  scheduleNext();

  const stop = () => {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (leaderTimer) clearInterval(leaderTimer);
    clearInterval(reclaimTimer);
    try { channel?.close(); } catch { /* */ }
    if (active && active.status().workerId === workerId) active = null;
  };

  active = { stop, status: () => ({ ...status }) };
  return stop;
}

/** One-shot reclaim helper for callers that want to nudge things on demand. */
export async function reclaimStaleBusinessEvents(): Promise<number> {
  try {
    const { data } = await supabase.rpc('reclaim_stale_business_events');
    return Array.isArray(data) ? data.length : 0;
  } catch { return 0; }
}

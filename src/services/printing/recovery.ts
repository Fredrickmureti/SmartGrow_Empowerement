/**
 * printing/recovery — the print RECOVERY sweeper.
 *
 * ## What this is not
 *
 * It is not a transport. No print in AccrualFlow reaches paper *because*
 * this module ran. A user-initiated print is dispatched synchronously by
 * `PrintService` on the session that requested it — that is the enterprise
 * standard (SAP LOCL/immediate output, D365 client-side document routing,
 * Odoo's direct IoT dispatch): the operator who pressed Print owns the
 * outcome and sees the failure.
 *
 * ## What it is
 *
 * A janitor for the ledger. `print_jobs` rows can be orphaned when the
 * session that owned them disappears mid-flight:
 *
 *   - the tab was closed / the browser crashed after the row was claimed;
 *   - the workstation was offline when the row was created (a server-side
 *     intent enqueued a job while nobody was watching);
 *   - a transient device failure left the row `failed` and an operator or
 *     administrator asked for a replay.
 *
 * For those rows — and only those rows — the sweeper re-runs
 * `PrintService.dispatchQueuedJob`, the exact same function the foreground
 * uses. There is no second render path, no second device resolver and no
 * second transport here; this module only decides *which* rows deserve a
 * retry and then hands them to the canonical dispatcher.
 *
 * ## Safety
 *
 * `dispatchQueuedJob` claims each row (`queued` → `sent`) before rendering,
 * so a sweeper tick and a live session can never both print the same job.
 * Rows younger than `ABANDON_AFTER_MS` are never touched: if a session is
 * mid-print, it still owns its own job.
 */
import { supabase } from '@/integrations/supabase/client';
import { dispatchQueuedJob, resolveOrganizationId } from './PrintService';
import { strandJobs, type QueuedJob } from './jobs';

/** A job stays the foreground session's business for this long. */
const ABANDON_AFTER_MS = 90_000;
/** How often the sweeper looks for orphans. Deliberately slow — nothing
 *  a user is waiting on ever depends on this interval. */
const SWEEP_INTERVAL_MS = 60_000;
/** Never flood a printer after an outage. */
const MAX_PER_SWEEP = 5;

const JOB_COLUMNS =
  'id, business_id, branch_id, document_record_id, artifact_id, disposition, medium, hardware_role, copies, correlation_id, doc_type, doc_id, render_params, status, transport';

/**
 * Phase 5.5 — a claimed row on a host-dialog transport is stranded, not
 * replayable. The PDF left the app the moment the dialog opened, so the
 * only honest close-out is `abandoned`; reprinting is the operator's
 * explicit decision, never the janitor's.
 */
const HOST_DIALOG_TRANSPORTS = new Set([
  'pdf-browser',
  'pdf-electron',
  'download',
  'virtual',
]);

function isStranded(job: QueuedJob): boolean {
  if (job.status !== 'sent') return false;
  // A download is terminal the moment the file reaches the operator's disk;
  // replaying it would silently re-save a document nobody asked for again.
  if ((job.disposition ?? 'print') === 'download') return true;
  return HOST_DIALOG_TRANSPORTS.has(job.transport ?? '');
}

export interface RecoveryStatus {
  startedAt: number;
  lastSweepAt: number | null;
  recovered: number;
  failed: number;
  /** Rows closed as `abandoned` because they could never be settled. */
  stranded: number;
  running: boolean;
}

let active: { stop: () => void; status: () => RecoveryStatus } | null = null;

export function getRecoveryStatus(): RecoveryStatus | null {
  return active?.status() ?? null;
}

/**
 * Find rows the owning session abandoned. `queued` older than the
 * abandonment window means nobody ever claimed it; `sent` older than the
 * window means somebody claimed it and never reported back.
 */
async function findAbandonedJobs(businessId: string, limit: number): Promise<QueuedJob[]> {
  const cutoff = new Date(Date.now() - ABANDON_AFTER_MS).toISOString();
  const { data, error } = await supabase
    .from('print_jobs')
    .select(JOB_COLUMNS)
    .eq('business_id', businessId)
    .in('status', ['queued', 'sent'])
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error || !Array.isArray(data)) return [];
  // Print-dispositioned rows are ours to replay; a stale `download` row is
  // ours to close out (Phase 5.5). Email/archive targets belong to their own
  // delivery channels and are left alone.
  return (data as unknown as QueuedJob[]).filter(
    (j) => (j.disposition ?? 'print') === 'print' || isStranded(j),
  );
}

/**
 * Run one sweep. Exported so administrators can trigger a replay on
 * demand instead of waiting for the timer.
 */
export async function sweepAbandonedPrintJobs(
  businessId: string,
  limit = MAX_PER_SWEEP,
): Promise<{ recovered: number; failed: number; stranded: number }> {
  const all = await findAbandonedJobs(businessId, limit);
  if (all.length === 0) return { recovered: 0, failed: 0, stranded: 0 };

  // Close stranded host-dialog rows instead of reprinting them.
  const strandedRows = all.filter(isStranded);
  const stranded = strandedRows.length
    ? await strandJobs(
        strandedRows.map((j) => j.id),
        'stranded: host print dialog owned the bytes; owning session never reported back',
      )
    : 0;

  const jobs = all.filter((j) => !isStranded(j));
  if (jobs.length === 0) return { recovered: 0, failed: 0, stranded };

  const organizationId = await resolveOrganizationId(businessId);
  let recovered = 0;
  let failed = 0;
  for (const job of jobs) {
    // Sequential: recovery must not interleave copies on a shared printer
    // any more than normal printing does.
    const outcome = await dispatchQueuedJob(job, organizationId);
    if (outcome === null) continue; // a live session took it back
    if (outcome.error) failed += 1;
    else recovered += 1;
  }
  return { recovered, failed, stranded };
}

/**
 * Start the background sweeper for the active business. Idempotent: a
 * second call replaces the first, so remounts cannot stack timers.
 */
export function startPrintRecoverySweeper(businessId: string): () => void {
  active?.stop();

  const status: RecoveryStatus = {
    startedAt: Date.now(),
    lastSweepAt: null,
    recovered: 0,
    failed: 0,
    stranded: 0,
    running: false,
  };

  let stopped = false;

  async function tick() {
    if (stopped || status.running) return;
    status.running = true;
    try {
      const res = await sweepAbandonedPrintJobs(businessId);
      status.recovered += res.recovered;
      status.failed += res.failed;
      status.stranded += res.stranded;
      status.lastSweepAt = Date.now();
    } catch {
      /* a failing janitor must never break the app */
    } finally {
      status.running = false;
    }
  }

  const timer = setInterval(tick, SWEEP_INTERVAL_MS);

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    if (active?.status() === status) active = null;
  };

  active = { stop, status: () => status };
  return stop;
}

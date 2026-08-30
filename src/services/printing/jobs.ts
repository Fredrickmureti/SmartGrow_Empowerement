/**
 * printing/jobs — the ONE print-job ledger writer.
 *
 * Every print in the ERP, whatever the document type, opens a row in
 * `print_jobs` before any bytes are rendered and closes it (acked /
 * failed) when the transport settles. Nothing else in the app may write
 * that table: `PrintService` is the only caller of this module, and this
 * module is the only caller of the `print_job_*` RPCs.
 *
 * Why a ledger at all: a print that produced no audit row is a print you
 * cannot reconcile, retry, or explain to an auditor. Enterprise spools
 * (SAP output management, D365 document routing) all persist the request
 * before dispatching it — the row is the request, the printer is just the
 * consumer.
 *
 * Why the client claims the row: `print_jobs` rows enqueued server-side by
 * `submit-document-intent` are also visible to the `dispatch-print-jobs`
 * cron sweeper. Flipping the row to `sent` the moment the interactive
 * session takes ownership makes `claim_print_jobs` (which only claims
 * `queued`) skip it, so an immediate foreground dispatch and the recovery
 * sweeper can never both print the same job.
 */
import { supabase } from '@/integrations/supabase/client';

export type PrintFormat = 'pdf';
export type PrintTransport = 'pdf-electron' | 'pdf-browser' | 'download' | 'none';

export interface OpenJobInput {
  businessId: string | null | undefined;
  branchId?: string | null;
  documentType: string;
  documentId?: string | null;
  intent: string;
  format: PrintFormat;
  transport: PrintTransport;
  correlationId: string;
  parentJobId?: string | null;
}

/**
 * A live ledger row. `id` is null when no business context was available
 * (platform-admin test prints), in which case every transition is a no-op
 * — printing is never blocked by the audit trail.
 */
export interface JobHandle {
  id: string | null;
  markSent: () => Promise<void>;
  markAcked: () => Promise<void>;
  markFailed: (error: string) => Promise<void>;
}

const NOOP_HANDLE: JobHandle = {
  id: null,
  markSent: async () => undefined,
  markAcked: async () => undefined,
  markFailed: async () => undefined,
};

export function noopJobHandle(): JobHandle {
  return NOOP_HANDLE;
}

/** Open a queued ledger row. Never throws; returns a no-op handle on failure. */
export async function openJob(input: OpenJobInput): Promise<JobHandle> {
  if (!input.businessId) return NOOP_HANDLE;
  try {
    const { data, error } = await supabase.rpc('print_job_insert', {
      p_business_id: input.businessId,
      p_branch_id: input.branchId ?? null,
      p_doc_type: input.documentType,
      p_doc_id: input.documentId || null,
      p_intent: input.intent,
      p_format: input.format,
      p_device_assignment_id: null,
      p_media_profile_id: null,
      p_correlation_id: input.correlationId,
      p_transport: input.transport,
      p_parent_job_id: input.parentJobId ?? null,
    });
    if (error || typeof data !== 'string') return NOOP_HANDLE;
    return handleFor(data);
  } catch {
    return NOOP_HANDLE;
  }
}

/** Wrap an existing job id (server-enqueued rows) in the same handle shape. */
export function handleFor(jobId: string): JobHandle {
  return {
    id: jobId,
    markSent: () => markSent(jobId),
    markAcked: () => markAcked(jobId),
    markFailed: (error: string) => markFailed(jobId, error),
  };
}

async function markSent(jobId: string): Promise<void> {
  try {
    await supabase.rpc('print_job_mark_sent', { p_id: jobId, p_hw_command_id: null });
  } catch { /* ledger failures never block printing */ }
}

async function markAcked(jobId: string): Promise<void> {
  try {
    await supabase.rpc('print_job_mark_acked_by_id', { p_id: jobId });
  } catch { /* noop */ }
}

async function markFailed(jobId: string, error: string): Promise<void> {
  try {
    await supabase.rpc('print_job_mark_failed', { p_id: jobId, p_error: error.slice(0, 500) });
  } catch { /* noop */ }
}

/** Shape of a server-enqueued `print_jobs` row the foreground dispatcher drains. */
export interface QueuedJob {
  id: string;
  business_id: string | null;
  branch_id: string | null;
  document_record_id: string | null;
  artifact_id: string | null;
  disposition: string | null;
  medium: string | null;
  hardware_role: string | null;
  copies: number | null;
  correlation_id: string | null;
  doc_type: string | null;
  doc_id: string | null;
  render_params: Record<string, unknown> | null;
  status: string | null;
  /** Transport the owning session chose (`thermal`, `pdf-browser`, …). */
  transport?: string | null;
}

/**
 * Read back the rows `submit-document-intent` just enqueued so the
 * foreground can dispatch them immediately instead of waiting for the
 * next sweeper tick.
 */
export async function loadJobs(jobIds: string[]): Promise<QueuedJob[]> {
  if (jobIds.length === 0) return [];
  const { data, error } = await supabase
    .from('print_jobs')
    .select(
      'id, business_id, branch_id, document_record_id, artifact_id, disposition, medium, hardware_role, copies, correlation_id, doc_type, doc_id, render_params, status',
    )
    .in('id', jobIds);
  if (error || !Array.isArray(data)) return [];
  return data as unknown as QueuedJob[];
}

/**
 * Take foreground ownership of a queued row. Returns false when the row
 * is no longer `queued` (the sweeper got there first) so the caller can
 * skip it rather than print it twice.
 */
export async function claimForForeground(job: QueuedJob): Promise<JobHandle | null> {
  if (job.status && job.status !== 'queued') return null;
  const handle = handleFor(job.id);
  await handle.markSent();
  return handle;
}

/**
 * Re-dispatch a settled row by asking the ledger to open a child job.
 * Admin surfaces call this instead of poking `print_jobs` themselves; the
 * recovery sweeper or the next foreground drain picks the child up.
 */
export async function resendJob(jobId: string): Promise<void> {
  const { error } = await supabase.rpc('print_job_resend', { p_id: jobId });
  if (error) throw error;
}

/**
 * Put a stalled/failed row back on the queue in place (no child row).
 * The operator workspace calls this; nothing else may touch the RPC, so
 * the ledger keeps exactly one module as its writer.
 */
export async function requeueJob(jobId: string): Promise<void> {
  const { error } = await (supabase as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
  }).rpc('requeue_print_job', { p_job_id: jobId });
  if (error) throw new Error(error.message);
}


/**
 * Phase 3 (POS latency): close N ledger rows in ONE round trip.
 *
 * The old shape was two RPCs per copy (`mark_sent` then `mark_acked`),
 * i.e. 2N cloud hops for an audit fact nobody is waiting on. The batch
 * RPC performs the same transition (`sent_at` + `acked_at` stamped, parent
 * fan-out rows promoted) for every id at once. Never throws — a ledger
 * failure must never surface as a print failure.
 */
export async function settleJobs(
  jobIds: Array<string | null | undefined>,
): Promise<void> {
  const ids = jobIds.filter((id): id is string => Boolean(id));
  if (ids.length === 0) return;
  try {
    await supabase.rpc('print_jobs_settle', {
      p_ids: ids,
      p_hw_command_id: null,
    } as never);
  } catch { /* ledger failures never block printing */ }
}

/**
 * Phase 5.5 — close rows that can never be settled truthfully.
 *
 * A `sent` row whose owning session vanished is not a print waiting to
 * happen: for paper output the bytes already reached the host print dialog,
 * so replaying it would put a second copy in the operator's hands. Those
 * rows are stranded, and the honest ledger state is `abandoned` with a
 * reason — not an eternal "in progress". Never throws.
 */
export async function strandJobs(
  jobIds: Array<string | null | undefined>,
  reason: string,
): Promise<number> {
  const ids = jobIds.filter((id): id is string => Boolean(id));
  if (ids.length === 0) return 0;
  try {
    const { data } = await supabase.rpc('print_jobs_strand', {
      p_ids: ids,
      p_reason: reason.slice(0, 500),
    } as never);
    return typeof data === 'number' ? data : 0;
  } catch {
    return 0;
  }
}

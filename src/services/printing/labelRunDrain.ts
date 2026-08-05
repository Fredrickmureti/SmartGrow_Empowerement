/**
 * labelRunDrain — foreground drain for the lines of one label run.
 *
 * Why this exists: `expand_label_run` enqueues a `print_jobs` row per line,
 * and the edge drainer can only relay those rows to a *paired workstation*.
 * Most label printers in the field are network or USB devices bound to the
 * operator's own session instead, which is exactly why a single label
 * printed fine while a bulk run stalled in `queued`.
 *
 * So the interactive session drains its own run through the canonical
 * dispatcher (`PrintService.dispatchQueuedJob`) — same claim, same compiler,
 * same hardware seam, same ledger transitions as a one-off label. The edge
 * drainer and the recovery sweeper remain the fallbacks for sessions that
 * closed mid-run; `claim` makes double printing impossible.
 */
import { supabase } from '@/integrations/supabase/client';
import { dispatchQueuedJob, resolveOrganizationId } from './PrintService';
import type { QueuedJob } from './jobs';

const JOB_COLUMNS =
  'id, business_id, branch_id, document_record_id, artifact_id, disposition, medium, ' +
  'hardware_role, copies, correlation_id, doc_type, doc_id, render_params, status, transport';

/** Never flood a printer from one tick; the rest is picked up on the next. */
const MAX_PER_DRAIN = 100;

export interface LabelRunDrainResult {
  printed: number;
  failed: number;
  lastError?: string;
}

/**
 * Dispatch every still-queued line of `runId` from this session.
 * Never throws: a run stays durable and recoverable whatever happens here.
 */
export async function drainLabelRunJobs(runId: string): Promise<LabelRunDrainResult> {
  const result: LabelRunDrainResult = { printed: 0, failed: 0 };
  try {
    const { data, error } = await supabase
      .from('print_jobs')
      .select(JOB_COLUMNS)
      .eq('intent', 'label')
      .eq('status', 'queued')
      .contains('render_params', { run_id: runId })
      .order('created_at', { ascending: true })
      .limit(MAX_PER_DRAIN);
    if (error || !Array.isArray(data) || data.length === 0) return result;

    const jobs = data as unknown as QueuedJob[];
    const organizationId = await resolveOrganizationId(jobs[0]?.business_id ?? null);

    // Sequential: a shared label printer must not interleave copies.
    for (const job of jobs) {
      const outcome = await dispatchQueuedJob(job, organizationId);
      if (outcome === null) continue; // another owner took it
      if (outcome.error) {
        result.failed += 1;
        result.lastError = outcome.error;
      } else {
        result.printed += 1;
      }
    }
  } catch {
    /* the run is durable; the sweeper is the backstop */
  }
  return result;
}

export default drainLabelRunJobs;

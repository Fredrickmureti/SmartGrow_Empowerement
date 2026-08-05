/**
 * PrintService — the ONE printing pipeline.
 *
 * Every printable business document in AccrualFlow — invoices, receipts,
 * kitchen tickets, delivery notes, payslips, shelf labels, asset tags —
 * enters here and travels the same five layers:
 *
 *   1. intent      caller says *what* to print, never *where* or *how*
 *   2. policy      `printing/policy` resolves format / copies / trigger
 *   3. ledger      `printing/jobs` opens a durable `print_jobs` row
 *   4. render      `printing/render` produces bytes (and archives them)
 *   5. dispatch    `printing/dispatch` resolves the device and emits
 *
 * There are no side doors. UI components do not call `generate-document`,
 * do not call `hardwareClient`, and do not write `print_jobs`. If a new
 * document type needs printing, it registers a policy row — it does not
 * add a code path.
 *
 * Ordering guarantee: `printDocument` awaits each copy and each job in
 * sequence, and the local agent keeps a FIFO queue per endpoint. Rapid
 * consecutive prints therefore land in click order for labels, receipts
 * and invoices alike — the behaviour the POS lane has always had, now
 * shared by every surface.
 *
 * Acknowledgement guarantee: the ledger row is opened before bytes exist
 * and closed only when the transport settles, so an operator asking "did
 * it print?" gets the same answer for a payslip as for a shelf label.
 */
import { resolvePrintPolicy, type ResolvedPrintPolicy } from './policy';
import {
  openJob,
  loadJobs,
  claimForForeground,
  noopJobHandle,
  settleJobs,
  type JobHandle,
  type PrintFormat,
  type PrintTransport,
  type QueuedJob,
} from './jobs';
import { renderDocumentRecord, renderPreviewSnapshot, type RenderedArtifact } from './render';
import {
  resolveSourceDocumentRecordId,
  type SourceDocumentContext,
} from '@/services/documents/resolveSourceDocumentRecord';
import { toDevice, toPage, toDownload, pdfTransport, NO_DEVICE_BOUND } from './dispatch';
import { renderLabelPayload, type LabelDispatchInput, type LabelRenderResult } from './labelDispatch';
import {
  enqueueDocumentIntent,
  materializeAndSubmitIntent,
  type SubmitDocumentIntentResult,
} from '@/services/documents/submitIntent';
import type { EnsureDocumentRecordInput } from '@/services/documents/ensureDocumentRecord';
import { supabase } from '@/integrations/supabase/client';
import { withTrace, withSpan, annotateTrace } from '@/services/observability/trace';
import type { PaperFormatOption } from './render';

export { NO_DEVICE_BOUND };

export type PrintDisposition = 'print' | 'download';

export interface PrintDocumentRequest {
  /** Business document type, e.g. `sales_invoice`, `pos_receipt`, `payslip`. */
  documentType: string;
  documentId: string;
  /** Hardware intent the platform resolves a device for. Defaults per medium. */
  intent?: string;
  organizationId?: string | null;
  businessId?: string | null;
  branchId?: string | null;
  /** Override the policy medium. Omit to let policy decide. */
  medium?: 'pdf' | 'escpos';
  /** Override the policy paper format for this print only. */
  paperFormat?: PaperFormatOption | null;
  copies?: number;
  disposition?: PrintDisposition;
  /** Filename stem used when the disposition is `download`. */
  filename?: string;
  /** Extra render inputs (statement periods, kitchen station, …). */
  extraBody?: Record<string, unknown>;
  station?: string | null;
  course?: string | null;
  table?: string | null;
  /** Rebuild layout settings from the current editor rather than the snapshot. */
  forceRefreshSettings?: boolean;

  correlationId?: string;
  isReprint?: boolean;
  businessEventId?: string | null;
}

export interface PrintResult {
  success: boolean;
  error?: string;
  /** True when the failure is "no printer bound" so the UI can show the CTA. */
  needsDevice?: boolean;
  jobIds: string[];
  transport: PrintTransport;
  copies: number;
  artifact?: RenderedArtifact;
}

function newCorrelationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `pj_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function defaultIntentFor(documentType: string, medium: 'pdf' | 'escpos'): string {
  if (medium === 'escpos') {
    if (documentType.includes('kitchen')) return 'kitchen_ticket';
    return 'receipt';
  }
  return 'a4_document';
}

/**
 * Print a business document. This is the entry point for every surface
 * in the app that has a "Print" affordance.
 *
 * Every stage is wrapped in a span (`@/services/observability/trace`) so
 * "where did the 18 seconds go?" is answered by reading `print_traces`,
 * not by guessing. The stage names here are the contract the diagnostics
 * waterfall renders.
 */
export async function printDocument(req: PrintDocumentRequest): Promise<PrintResult> {
  const correlationId = req.correlationId ?? newCorrelationId();
  return withTrace(
    {
      label: req.documentType,
      correlationId,
      attributes: {
        entry: 'printDocument',
        document_type: req.documentType,
        document_id: req.documentId,
        reprint: req.isReprint ?? false,
      },
    },
    () => printDocumentTraced(req, correlationId),
  );
}

/**
 * Phase 2 (POS latency redesign): a print is now two distinct moments.
 *
 *   1. ACKNOWLEDGEMENT — policy resolved and durable `print_jobs` rows
 *      opened. The request is now recoverable by the sweeper even if the
 *      tab closes. This is what the cashier waits for.
 *   2. COMPLETION — render + dispatch + ledger close. Nobody waits for
 *      this; the UI follows the ledger rows instead.
 *
 * `printDocument` still awaits both (every non-POS caller keeps its old
 * semantics); `startPrintDocument` returns at (1) and hands back a
 * promise for (2).
 */
interface PrintPlan {
  handles: JobHandle[];
  jobIds: string[];
  medium: 'pdf' | 'escpos';
  copies: number;
  disposition: PrintDisposition;
  intent: string;
  paperFormat: PaperFormatOption | null;
  transport: PrintTransport;
}

async function planPrint(
  req: PrintDocumentRequest,
  correlationId: string,
): Promise<PrintPlan> {
  let policy: ResolvedPrintPolicy | null = null;
  try {
    policy = await withSpan(
      'policy.resolve',
      () => resolvePrintPolicy(req.businessId, req.branchId, req.documentType),
      undefined,
      correlationId,
    );

  } catch {
    policy = null;
  }

  const medium: 'pdf' | 'escpos' =
    req.medium ?? (policy?.renderMode === 'escpos' ? 'escpos' : 'pdf');
  const copies = Math.max(1, req.copies ?? policy?.copies ?? 1);
  const disposition: PrintDisposition = req.disposition ?? 'print';
  const intent = req.intent ?? defaultIntentFor(req.documentType, medium);
  const paperFormat =
    req.paperFormat ??
    (policy?.paperFormat ? (policy.paperFormat as PaperFormatOption) : undefined) ??
    null;

  const transport: PrintTransport =
    disposition === 'download' ? 'download' : medium === 'escpos' ? 'thermal' : pdfTransport();

  annotateTrace({ medium, copies, disposition, intent, transport }, correlationId);

  // Ledger rows are independent of one another — one round trip per copy
  // in series was pure dead time on the cashier's clock.
  const handles: JobHandle[] = await withSpan(
    'ledger.open',
    () =>
      Promise.all(
        Array.from({ length: copies }, () =>
          openJob({
            businessId: req.businessId,
            branchId: req.branchId ?? null,
            documentType: req.documentType,
            documentId: req.documentId,
            intent,
            format: medium as PrintFormat,
            transport,
            correlationId,
          }),
        ),
      ),
    { copies },
    correlationId,
  );

  const jobIds = handles.map((h) => h.id).filter((id): id is string => Boolean(id));

  return { handles, jobIds, medium, copies, disposition, intent, paperFormat, transport };
}

async function executePrint(
  plan: PrintPlan,
  req: PrintDocumentRequest,
  correlationId: string,
): Promise<PrintResult> {
  const { handles, jobIds, medium, copies, disposition, intent, paperFormat, transport } = plan;

  // ---- render once, dispatch N times -------------------------------
  let artifact: RenderedArtifact;
  try {
    artifact = await withSpan(
      'render.source_pair',
      () =>
        renderSourcePair({
          documentType: req.documentType,
          documentId: req.documentId,
          medium,
          paperFormat,
          correlationId,
          context: {
            organizationId: req.organizationId ?? null,
            businessId: req.businessId ?? null,
            branchId: req.branchId ?? null,
          },
          options: {
            ...(req.extraBody ?? {}),
            ...(req.station ? { station: req.station } : {}),
            ...(req.course ? { course: req.course } : {}),
            ...(req.table ? { table: req.table } : {}),
            ...(req.forceRefreshSettings ? { force_refresh_settings: true } : {}),
          },
        }),
      undefined,
      correlationId,
    );
    annotateTrace(
      { artifact_bytes: artifact.bytes.length, artifact_medium: artifact.medium },
      correlationId,
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await Promise.all(handles.map((h) => h.markFailed(error)));
    return { success: false, error, jobIds, transport, copies };
  }

  // Sequential on purpose — copy 2 must never overtake copy 1.
  const settled: string[] = [];
  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i];
    // Phase 5.4 — a PDF job is terminal at host handoff. Settle it there so
    // the row does not linger in `sent` while the OS dialog is open (and so
    // the recovery sweeper never replays a print the operator already has).
    let handedOff = false;
    const outcome = await withSpan(
      'dispatch.copy',
      () =>
        emit(artifact, {
          intent,
          disposition,
          req,
          correlationId,
          onHandedToHost: () => {
            handedOff = true;
            if (handle.id) void settleJobs([handle.id]);
          },
        }),
      { copy: i + 1 },
      correlationId,
    );

    if (!outcome.success) {
      await handle.markFailed(outcome.error ?? 'dispatch failed');
      return {
        success: false,
        error: outcome.error,
        needsDevice: Boolean(outcome.error?.startsWith(NO_DEVICE_BOUND)),
        jobIds,
        transport,
        copies,
        artifact,
      };
    }
    if (handle.id && !handedOff) settled.push(handle.id);
  }

  // Phase 3: one batched ledger close for every copy instead of two RPCs
  // per copy. The paper is already out — this is an audit fact, so it is
  // fire-and-forget relative to the caller.
  void settleJobs(settled);

  return { success: true, jobIds, transport, copies, artifact };
}

async function printDocumentTraced(
  req: PrintDocumentRequest,
  correlationId: string,
): Promise<PrintResult> {
  const plan = await planPrint(req, correlationId);
  return executePrint(plan, req, correlationId);
}

/** What the caller gets back the moment the print is durable. */
export interface PrintAcknowledgement {
  /** False only when the request could not even be queued. */
  queued: boolean;
  error?: string;
  jobIds: string[];
  correlationId: string;
  transport: PrintTransport;
  copies: number;
  /** Resolves when the bytes have actually been dispatched. Never rejects. */
  completion: Promise<PrintResult>;
}

/**
 * Queue a print and return as soon as the ledger rows exist.
 *
 * The render + dispatch continue in the background; watch the returned
 * `jobIds` in `print_jobs` (Realtime) or await `completion` for the
 * terminal outcome. Used by the POS post-payment screen so the cashier
 * is released at "queued", not at "printer finished".
 */
export async function startPrintDocument(
  req: PrintDocumentRequest,
): Promise<PrintAcknowledgement> {
  const correlationId = req.correlationId ?? newCorrelationId();
  let ack!: (value: Omit<PrintAcknowledgement, 'completion'>) => void;
  const acked = new Promise<Omit<PrintAcknowledgement, 'completion'>>((resolve) => {
    ack = resolve;
  });

  const completion = withTrace(
    {
      label: req.documentType,
      correlationId,
      attributes: {
        entry: 'startPrintDocument',
        document_type: req.documentType,
        document_id: req.documentId,
        reprint: req.isReprint ?? false,
        non_blocking: true,
      },
    },
    async (): Promise<PrintResult> => {
      let plan: PrintPlan;
      try {
        plan = await planPrint(req, correlationId);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ack({ queued: false, error, jobIds: [], correlationId, transport: 'none', copies: 0 });
        return { success: false, error, jobIds: [], transport: 'none', copies: 0 };
      }
      ack({
        queued: true,
        jobIds: plan.jobIds,
        correlationId,
        transport: plan.transport,
        copies: plan.copies,
      });
      try {
        return await executePrint(plan, req, correlationId);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await Promise.all(plan.handles.map((h) => h.markFailed(error)));
        return {
          success: false,
          error,
          jobIds: plan.jobIds,
          transport: plan.transport,
          copies: plan.copies,
        };
      }
    },
  );

  // A rejection here would otherwise surface as an unhandled rejection in
  // the background task — normalise it into a failed result.
  const safeCompletion = completion.catch((err): PrintResult => {
    const error = err instanceof Error ? err.message : String(err);
    ack({ queued: false, error, jobIds: [], correlationId, transport: 'none', copies: 0 });
    return { success: false, error, jobIds: [], transport: 'none', copies: 0 };
  });

  return { ...(await acked), completion: safeCompletion };
}




async function emit(
  artifact: RenderedArtifact,
  ctx: {
    intent: string;
    disposition: PrintDisposition;
    req: PrintDocumentRequest;
    correlationId: string;
    /** Phase 5.4 — fired when paper output reaches the host print dialog. */
    onHandedToHost?: () => void;
  },
) {
  const { req } = ctx;
  if (ctx.disposition === 'download') {
    if (!artifact.blob) {
      return { success: false, error: 'only PDF artifacts can be downloaded' };
    }
    return toDownload(artifact.blob, req.filename ?? `${req.documentType}-${req.documentId}`);
  }
  if (artifact.medium === 'pdf') {
    // A4/office output goes through the host print dialog; the operator's
    // OS printer selection is the device binding for paper documents.
    return toPage(artifact.blob!, { onHandedToHost: ctx.onHandedToHost });
  }
  return toDevice({
    intentOrRole: ctx.intent,
    op: 'print_raw',
    payload: { bytes: Array.from(artifact.bytes) },
    organizationId: req.organizationId ?? null,
    businessId: req.businessId ?? null,
    idempotencyKey: `${ctx.correlationId}:${req.documentType}:${req.documentId}`,
    sourceDocType: req.documentType,
    sourceDocId: req.documentId,
    businessEventId: req.businessEventId ?? null,
    isReprint: req.isReprint,
  });
}

// ---------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------

export interface PrintLabelRequest extends LabelDispatchInput {
  businessId?: string | null;
  copies?: number;
}

export interface LabelPrintResult {
  success: boolean;
  error?: string;
  needsDevice?: boolean;
  jobIds: string[];
  templateResolved?: { engine: string; version: number; scope: string };
  mediaResolved?: { profileId: string; widthMm: number; heightMm: number | null; dpi: number };
}

/**
 * Print a label template. Same five layers as `printDocument`; only the
 * render step differs, because label bytes come from `label_templates`
 * rather than the document renderer.
 */
export async function printLabel(req: PrintLabelRequest): Promise<LabelPrintResult> {
  const rendered = await renderLabelPayload(req);
  if (rendered.ok === false) {
    return {
      success: false,
      error: rendered.error,
      needsDevice: rendered.error.startsWith(NO_DEVICE_BOUND),
      jobIds: [],
    };
  }

  const correlationId = newCorrelationId();
  const copies = Math.max(1, req.copies ?? 1);
  const format: PrintFormat = rendered.templateResolved.engine === 'pdf'
    ? 'pdf'
    : (rendered.templateResolved.engine as PrintFormat);

  const jobIds: string[] = [];
  for (let i = 0; i < copies; i++) {
    const handle = req.businessId
      ? await openJob({
          businessId: req.businessId,
          branchId: req.branchId ?? null,
          documentType: req.templateKey,
          documentId: req.sourceDocId ?? null,
          intent: 'label',
          format,
          transport: 'thermal',
          correlationId,
          mediaProfileId: rendered.mediaResolved?.profileId ?? null,
        })
      : noopJobHandle();
    if (handle.id) jobIds.push(handle.id);

    const outcome = await toDevice({
      intentOrRole: rendered.role,
      op: 'print_raw',
      payload: rendered.payload,
      organizationId: req.orgId,
      businessId: req.businessId ?? null,
      idempotencyKey: copies > 1
        ? `${rendered.idempotencyKey}:${i + 1}`
        : rendered.idempotencyKey,
      sourceDocType: req.sourceDocType ?? null,
      sourceDocId: req.sourceDocId ?? null,
      businessEventId: req.businessEventId ?? null,
      isReprint: req.isReprint,
    });

    if (!outcome.success) {
      await handle.markFailed(outcome.error ?? 'dispatch failed');
      return {
        success: false,
        error: outcome.error,
        needsDevice: Boolean(outcome.error?.startsWith(NO_DEVICE_BOUND)),
        jobIds,
        templateResolved: rendered.templateResolved,
        mediaResolved: rendered.mediaResolved,
      };
    }
    await handle.markSent(null);
    await handle.markAcked();
  }

  return {
    success: true,
    jobIds,
    templateResolved: rendered.templateResolved,
    mediaResolved: rendered.mediaResolved,
  };
}

/**
 * Compile a label without dispatching it — the sanctioned preview seam.
 *
 * Surfaces that show "what will come out of the printer" (LPN label
 * dialog, template editors) call this instead of reaching into
 * `printing/labelDispatch`, so there is still exactly one module that
 * knows how label bytes are produced. Nothing is printed and no ledger
 * row is opened: a preview is a render, not a print.
 */
export async function previewLabel(
  req: LabelDispatchInput,
): Promise<LabelRenderResult> {
  return renderLabelPayload(req);
}

// ---------------------------------------------------------------------
// Document-model intents
// ---------------------------------------------------------------------

/**
 * Dispatch a Document Record through the routing plan and drain the
 * resulting jobs immediately in the foreground.
 *
 * The server decides *which* targets apply (print / email / archive); the
 * interactive session prints its own print-targets right away instead of
 * waiting up to 30s for the sweeper tick. Claiming each row first means
 * the sweeper — which now exists purely as a recovery path for sessions
 * that closed mid-print — can never duplicate the output.
 */
export async function printDocumentIntent(input: {
  documentRecordId: string;
  scenario?: string;
  triggeredSource?: 'business_event' | 'manual' | 'reprint' | 'api';
  organizationId?: string | null;
}): Promise<PrintResult & SubmitDocumentIntentResult> {
  return withTrace(
    {
      label: 'document_intent',
      attributes: {
        entry: 'printDocumentIntent',
        document_record_id: input.documentRecordId,
        triggered_source: input.triggeredSource ?? 'manual',
      },
    },
    async (ctx) => {
      const cid = ctx?.correlationId;
      const submitted = await withSpan(
        'intent.submit',
        () =>
          enqueueDocumentIntent({
            documentRecordId: input.documentRecordId,
            scenario: input.scenario,
            triggeredSource: input.triggeredSource ?? 'manual',
          }),
        undefined,
        cid,
      );

      // The job rows and the tenant lookup do not depend on each other.
      const [jobs, orgFromInput] = await withSpan(
        'intent.load_jobs',
        () =>
          Promise.all([
            loadJobs(submitted.job_ids),
            Promise.resolve(input.organizationId ?? null),
          ]),
        undefined,
        cid,
      );
      // Device resolution needs org context. Call sites pass a document, not a
      // tenant, so resolve it from the job's business when omitted.
      const organizationId =
        orgFromInput ??
        (await withSpan(
          'intent.resolve_org',
          () => resolveOrganizationId(jobs[0]?.business_id ?? null),
          undefined,
          cid,
        ));

      return { ...submitted, ...(await drainIntentJobs(jobs, organizationId, cid)) };
    },
  );
}

/**
 * Drain the print-targets of an already-submitted routing plan.
 *
 * Shared by the two-hop legacy entry (`printDocumentIntent`) and the
 * Phase 3 single-hop entry (`printSourceDocumentIntent`) so there is
 * exactly one foreground drainer, whichever way the jobs were enqueued.
 */
async function drainIntentJobs(
  jobs: QueuedJob[],
  organizationId: string | null,
  correlationId?: string,
): Promise<PrintResult> {
  let transport: PrintTransport = 'none';
  let printed = 0;
  let lastError: string | undefined;

  annotateTrace({ job_count: jobs.length }, correlationId);

  for (const job of jobs) {
    if ((job.disposition ?? 'print') !== 'print') continue;
    const outcome = await withSpan(
      'intent.dispatch_job',
      () => dispatchQueuedJob(job, organizationId, correlationId),
      undefined,
      correlationId,
    );
    if (outcome === null) continue; // sweeper owns it
    transport = outcome.transport;
    if (outcome.error) lastError = outcome.error;
    else printed += 1;
  }

  return {
    success: !lastError,
    error: lastError,
    needsDevice: Boolean(lastError?.startsWith(NO_DEVICE_BOUND)),
    jobIds: jobs.map((j) => j.id),
    transport,
    copies: printed,
  };
}

/**
 * Phase 3 (POS latency): materialize the document record, submit its
 * output intent and read back the enqueued rows in ONE round trip, then
 * drain them through the same foreground dispatcher.
 *
 * Replaces `ensureDocumentRecord` → `submit-document-intent` (Edge cold
 * boot) → `loadJobs` → `resolveOrganizationId`: four sequential hops
 * become one. Behaviour is otherwise identical — same authorisation, same
 * dedupe, same ledger rows, same sweeper recovery.
 */
export async function printSourceDocumentIntent(
  input: EnsureDocumentRecordInput & {
    scenario?: string;
    triggeredSource?: 'business_event' | 'manual' | 'reprint' | 'api';
  },
): Promise<PrintResult & SubmitDocumentIntentResult> {
  return withTrace(
    {
      label: 'document_intent',
      attributes: {
        entry: 'printSourceDocumentIntent',
        kind_code: input.kindCode,
        source_doc_id: input.sourceDocId,
        triggered_source: input.triggeredSource ?? 'manual',
      },
    },
    async (ctx) => {
      const cid = ctx?.correlationId;
      const submitted = await withSpan(
        'intent.materialize_submit',
        () =>
          materializeAndSubmitIntent({
            ...input,
            triggeredSource: input.triggeredSource ?? 'manual',
          }),
        undefined,
        cid,
      );
      const jobs = submitted.jobs as unknown as QueuedJob[];
      const organizationId = submitted.organization_id ?? input.organizationId ?? null;
      return { ...submitted, ...(await drainIntentJobs(jobs, organizationId, cid)) };
    },
  );
}

// ---------------------------------------------------------------------
// Phase 5.1 — non-blocking intent entries
// ---------------------------------------------------------------------

/**
 * What an intent caller gets back the moment the routing plan is durable.
 *
 * Same two-moment contract as `startPrintDocument`:
 *
 *   1. ACKNOWLEDGEMENT — the document record exists, the routing plan is
 *      resolved and one `print_jobs` row per target is committed. The
 *      request is now recoverable by the sweeper even if the tab closes.
 *      This is all any operator should ever wait for.
 *   2. COMPLETION — claim + render + device resolve + dispatch + settle.
 *      Nobody waits for it; surfaces follow the ledger rows instead.
 */
export interface IntentAcknowledgement {
  /** False only when the request could not even be queued. */
  queued: boolean;
  error?: string;
  jobIds: string[];
  targetCount: number;
  correlationId: string;
  documentRecordId: string | null;
  /** Resolves when the jobs have actually been drained. Never rejects. */
  completion: Promise<PrintResult>;
}

function failedAck(
  error: string,
  correlationId: string,
  documentRecordId: string | null,
): Omit<IntentAcknowledgement, 'completion'> {
  return { queued: false, error, jobIds: [], targetCount: 0, correlationId, documentRecordId };
}

/**
 * Shared engine for both non-blocking intent entries. There is exactly one
 * drainer (`drainIntentJobs`) and exactly one place that decides when the
 * caller is released, so the blocking and non-blocking entries can never
 * drift apart.
 */
async function startIntent(
  meta: { label: string; attributes: Record<string, unknown> },
  submit: (
    correlationId: string,
  ) => Promise<{
    submitted: SubmitDocumentIntentResult;
    jobs: QueuedJob[];
    organizationId: string | null;
  }>,
): Promise<IntentAcknowledgement> {
  const correlationId = newCorrelationId();
  let ack!: (value: Omit<IntentAcknowledgement, 'completion'>) => void;
  const acked = new Promise<Omit<IntentAcknowledgement, 'completion'>>((resolve) => {
    ack = resolve;
  });

  const completion = withTrace(
    {
      label: meta.label,
      correlationId,
      attributes: { ...meta.attributes, non_blocking: true },
    },
    async (): Promise<PrintResult> => {
      let plan: { submitted: SubmitDocumentIntentResult; jobs: QueuedJob[]; organizationId: string | null };
      try {
        plan = await submit(correlationId);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ack(failedAck(error, correlationId, null));
        return { success: false, error, jobIds: [], transport: 'none', copies: 0 };
      }
      ack({
        queued: true,
        jobIds: plan.submitted.job_ids ?? plan.jobs.map((j) => j.id),
        targetCount: plan.submitted.target_count ?? plan.jobs.length,
        correlationId,
        documentRecordId: plan.submitted.document_record_id ?? null,
      });
      return drainIntentJobs(plan.jobs, plan.organizationId, correlationId);
    },
  );

  // A rejection here would surface as an unhandled rejection in a task
  // nobody awaits — normalise it into a failed result instead.
  const safeCompletion = completion.catch((err): PrintResult => {
    const error = err instanceof Error ? err.message : String(err);
    ack(failedAck(error, correlationId, null));
    return { success: false, error, jobIds: [], transport: 'none', copies: 0 };
  });

  return { ...(await acked), completion: safeCompletion };
}

/**
 * Non-blocking twin of `printDocumentIntent`: returns once the routing
 * plan and its ledger rows are committed, and drains in the background.
 */
export async function startPrintDocumentIntent(input: {
  documentRecordId: string;
  scenario?: string;
  triggeredSource?: 'business_event' | 'manual' | 'reprint' | 'api';
  organizationId?: string | null;
}): Promise<IntentAcknowledgement> {
  return startIntent(
    {
      label: 'document_intent',
      attributes: {
        entry: 'startPrintDocumentIntent',
        document_record_id: input.documentRecordId,
        triggered_source: input.triggeredSource ?? 'manual',
      },
    },
    async (correlationId) => {
      const submitted = await withSpan(
        'intent.submit',
        () =>
          enqueueDocumentIntent({
            documentRecordId: input.documentRecordId,
            scenario: input.scenario,
            triggeredSource: input.triggeredSource ?? 'manual',
          }),
        undefined,
        correlationId,
      );
      const jobs = await withSpan(
        'intent.load_jobs',
        () => loadJobs(submitted.job_ids),
        undefined,
        correlationId,
      );
      const organizationId =
        input.organizationId ??
        (await withSpan(
          'intent.resolve_org',
          () => resolveOrganizationId(jobs[0]?.business_id ?? null),
          undefined,
          correlationId,
        ));
      return { submitted, jobs, organizationId };
    },
  );
}

/**
 * Non-blocking twin of `printSourceDocumentIntent` — the entry every
 * document surface should use. One RPC materializes the record, submits
 * the intent and returns the enqueued rows; the caller is released there.
 */
export async function startPrintSourceDocumentIntent(
  input: EnsureDocumentRecordInput & {
    scenario?: string;
    triggeredSource?: 'business_event' | 'manual' | 'reprint' | 'api';
  },
): Promise<IntentAcknowledgement> {
  return startIntent(
    {
      label: 'document_intent',
      attributes: {
        entry: 'startPrintSourceDocumentIntent',
        kind_code: input.kindCode,
        source_doc_id: input.sourceDocId,
        triggered_source: input.triggeredSource ?? 'manual',
      },
    },
    async (correlationId) => {
      const submitted = await withSpan(
        'intent.materialize_submit',
        () =>
          materializeAndSubmitIntent({
            ...input,
            triggeredSource: input.triggeredSource ?? 'manual',
          }),
        undefined,
        correlationId,
      );
      return {
        submitted,
        jobs: submitted.jobs as unknown as QueuedJob[],
        organizationId: submitted.organization_id ?? input.organizationId ?? null,
      };
    },
  );
}




/**
 * Dispatch ONE ledger row through the canonical path: claim → render →
 * resolve device → dispatch → settle. Both the foreground (interactive
 * print) and the recovery sweeper call this and only this, so a recovered
 * job takes the exact same code path as a fresh one — there is no second
 * dispatcher to drift from.
 *
 * Returns null when the row was already claimed by someone else.
 */
export async function dispatchQueuedJob(
  job: QueuedJob,
  organizationId: string | null,
  correlationId?: string,
): Promise<{ transport: PrintTransport; error?: string } | null> {
  const handle = await withSpan(
    'job.claim',
    () => claimForForeground(job),
    undefined,
    correlationId,
  );
  if (!handle) return null;

  let transport: PrintTransport = 'none';
  let handedOff = false;
  try {
    const medium = job.medium === 'escpos' ? 'escpos' : 'pdf';
    const renderOptions = renderOptionsForJob(job);
    const artifact = await withSpan(
      'render.document',
      () =>
        job.document_record_id
          ? renderDocumentRecord({
              documentRecordId: job.document_record_id,
              medium,
              correlationId,
              options: renderOptions,
            })
          : renderSourcePair({
              // Ledger rows written before the document-model migration carry a
              // bare (type, id) pair. They are frozen into a record on recovery
              // so even a replayed legacy job archives its artifact.
              documentType: job.doc_type ?? 'document',
              documentId: job.doc_id ?? '',
              medium,
              paperFormat: paperFormatFromRenderOptions(renderOptions),
              context: { businessId: job.business_id ?? null },
              options: renderOptions,
              correlationId,
            }),
      { medium, from_record: Boolean(job.document_record_id) },
      correlationId,
    );

    const copies = Math.max(1, job.copies ?? 1);
    for (let i = 0; i < copies; i++) {
      const outcome = await withSpan(
        'dispatch.job_copy',
        () =>
          artifact.medium === 'pdf' && artifact.blob
            ? toPage(artifact.blob, {
                onHandedToHost: () => {
                  handedOff = true;
                  void handle.markAcked();
                },
              })
            : toDevice({
                intentOrRole: job.hardware_role ?? 'receipt',
                op: 'print_raw',
                payload: { bytes: Array.from(artifact.bytes) },
                organizationId,
                businessId: job.business_id,
                idempotencyKey: `${job.id}:${i + 1}`,
                sourceDocType: job.doc_type ?? null,
                sourceDocId: job.doc_id ?? null,
                correlationId,
              }),
        { copy: i + 1, bytes: artifact.bytes.length },
        correlationId,
      );
      transport = outcome.transport;
      if (!outcome.success) throw new Error(outcome.error ?? 'dispatch failed');
    }
    // Settling the ledger is an audit fact; the paper is already out.
    // PDF jobs already settled at host handoff (Phase 5.4).
    if (!handedOff) void handle.markAcked();
    return { transport };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await handle.markFailed(error);
    return { transport, error };
  }
}

function renderOptionsForJob(job: QueuedJob): Record<string, unknown> {
  return {
    ...(job.render_params ?? {}),
    copies: job.copies ?? 1,
    intent: job.disposition ?? 'print',
  };
}

function paperFormatFromRenderOptions(
  options: Record<string, unknown>,
): PaperFormatOption | null {
  const paper = options.paper_format;
  if (
    paper === '40mm' ||
    paper === '58mm' ||
    paper === '80mm' ||
    paper === 'a4' ||
    paper === 'a5' ||
    paper === 'letter'
  ) {
    return paper;
  }
  return null;
}

export { resolveOrganizationId };

const orgByBusiness = new Map<string, string | null>();

async function resolveOrganizationId(businessId: string | null): Promise<string | null> {
  if (!businessId) return null;
  if (orgByBusiness.has(businessId)) return orgByBusiness.get(businessId) ?? null;
  try {
    const { data } = await supabase
      .from('businesses')
      .select('organization_id')
      .eq('id', businessId)
      .maybeSingle();
    const orgId = (data?.organization_id as string | undefined) ?? null;
    orgByBusiness.set(businessId, orgId);
    return orgId;
  } catch {
    return null;
  }
}

/**
 * Download a document-model record as a file.
 *
 * A download is a disposition, not an escape hatch: it still opens a
 * ledger row, still renders through `render-document` (so the archived
 * artifact and the bytes the user receives are the same object), and
 * still settles the row. Self-service surfaces (payslips, tax
 * certificates) use this instead of hand-rolled `functions.invoke` +
 * `URL.createObjectURL`, which produced files no audit trail knew about.
 */
export async function downloadDocumentRecord(input: {
  documentRecordId: string;
  filename: string;
  businessId?: string | null;
  branchId?: string | null;
  documentType?: string;
  documentId?: string | null;
  intent?: string;
}): Promise<PrintResult> {
  const correlationId = newCorrelationId();
  const handle = input.businessId
    ? await openJob({
        businessId: input.businessId,
        branchId: input.branchId ?? null,
        documentType: input.documentType ?? 'document',
        documentId: input.documentId ?? null,
        intent: input.intent ?? 'download',
        format: 'pdf',
        transport: 'download',
        correlationId,
      })
    : noopJobHandle();
  const jobIds = handle.id ? [handle.id] : [];

  try {
    const artifact = await renderDocumentRecord({
      documentRecordId: input.documentRecordId,
      medium: 'pdf',
    });
    if (!artifact.blob) throw new Error('render_returned_no_pdf');
    const outcome = toDownload(artifact.blob, input.filename);
    if (!outcome.success) throw new Error(outcome.error ?? 'download failed');
    await handle.markSent(null);
    await handle.markAcked();
    return { success: true, jobIds, transport: 'download', copies: 1, artifact };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await handle.markFailed(error);
    return { success: false, error, jobIds, transport: 'download', copies: 1 };
  }
}

export const PrintService = {
  renderDocumentBlob,
  renderDocumentPreview,
  openInteractiveJob,
  printDocument,
  printLabel,
  previewLabel,
  printDocumentIntent,
  printSourceDocumentIntent,
  downloadDocumentRecord,
  downloadArchivedArtifact,
};


// ---------------------------------------------------------------------
// Rendering-only entries (preview surfaces)
// ---------------------------------------------------------------------

/**
 * Render a legacy `(documentType, documentId)` pair.
 *
 * There is no second renderer: the pair is frozen into a document record
 * (idempotently) and then rendered by `render-document`, so preview,
 * print, download and reprint all read the same archived artifact.
 */
async function renderSourcePair(input: {
  documentType: string;
  documentId: string;
  medium: 'pdf' | 'escpos';
  paperFormat?: PaperFormatOption | null;
  context?: SourceDocumentContext;
  options?: Record<string, unknown>;
  /** Trace key so render spans attach to the caller's trace, not the ambient one. */
  correlationId?: string;
}): Promise<RenderedArtifact> {
  const documentRecordId = await resolveSourceDocumentRecordId(
    input.documentType,
    input.documentId,
    input.context ?? {},
  );
  return renderDocumentRecord({
    documentRecordId,
    medium: input.medium,
    correlationId: input.correlationId,
    options: {
      ...(input.options ?? {}),
      ...(input.paperFormat ? { paper_format: input.paperFormat } : {}),
    },
  });
}


/**
 * Produce the artifact a preview surface displays, together with the paper
 * policy the server applied. Preview is a *render*, not a print: no ledger
 * row is opened here, because nothing was committed to paper. When the
 * operator then hits Print inside the preview, that click goes through
 * `openInteractiveJob` + the transport below, so the ledger still covers
 * every physical print.
 *
 * Preview and print therefore share one renderer AND one snapshot: what the
 * operator sees is the archived artifact the printer will receive.
 */
export async function renderDocumentPreview(input: {
  documentType: string;
  documentId: string;
  medium?: 'pdf' | 'escpos';
  paperFormat?: PaperFormatOption | null;
  branchId?: string | null;
  forceRenderMode?: boolean;
  extraBody?: Record<string, unknown>;
}): Promise<RenderedArtifact> {
  return renderSourcePair({
    documentType: input.documentType,
    documentId: input.documentId,
    medium: input.medium ?? 'pdf',
    paperFormat: input.paperFormat ?? null,
    context: { branchId: input.branchId ?? null },
    options: {
      ...(input.extraBody ?? {}),
      ...(input.forceRenderMode ? { force_render_mode: true } : {}),
    },
  });
}

/**
 * Render an *unsaved* snapshot — the settings-validation preview.
 *
 * Same front door, same renderer, same template resolution as a real
 * document; the only difference is that the document does not exist yet,
 * so nothing is archived and no ledger row is opened. Used by the receipt
 * test print, where the operator is validating settings they have not
 * saved.
 */
export async function renderSnapshotPreview(input: {
  kindCode: string;
  organizationId: string;
  businessId: string;
  branchId?: string | null;
  snapshot: Record<string, unknown>;
  medium?: 'pdf' | 'escpos';
  options?: Record<string, unknown>;
}): Promise<RenderedArtifact> {
  return renderPreviewSnapshot({
    kindCode: input.kindCode,
    organizationId: input.organizationId,
    businessId: input.businessId,
    branchId: input.branchId ?? null,
    snapshot: input.snapshot,
    medium: input.medium ?? 'escpos',
    options: input.options ?? {},
  });
}

/** Convenience wrapper for callers that only need the PDF bytes. */
export async function renderDocumentBlob(
  documentType: string,
  documentId: string,
  opts?: { paperFormat?: PaperFormatOption | null; extraBody?: Record<string, unknown> },
): Promise<Blob> {
  const artifact = await renderDocumentPreview({
    documentType,
    documentId,
    medium: 'pdf',
    paperFormat: opts?.paperFormat ?? null,
    extraBody: opts?.extraBody,
  });
  if (!artifact.blob) throw new Error('renderer did not return a PDF');
  return artifact.blob;
}

/**
 * Deliver an artifact whose bytes were FROZEN SERVER-SIDE at issue time.
 *
 * Statutory documents (tax certificates, filed returns) are not re-rendered
 * on demand: the file that was serialised and serial-numbered at issuance is
 * the legal object, and re-rendering it would break that guarantee. They are
 * therefore fetched from the archive rather than produced by
 * `render-document` — but they are NOT an escape hatch: this is a
 * disposition, so it still opens a `print_jobs` row, still settles it, and
 * still leaves the same audit trail as a printed invoice.
 *
 * Use this ONLY for bytes the server already archived. Anything renderable
 * belongs on `downloadDocumentRecord`.
 */
export async function downloadArchivedArtifact(input: {
  /** Signed, short-lived URL to the archived object. */
  sourceUrl: string;
  filename: string;
  documentType: string;
  documentId?: string | null;
  businessId?: string | null;
  branchId?: string | null;
  intent?: string;
}): Promise<PrintResult> {
  const handle = await openInteractiveJob({
    documentType: input.documentType,
    documentId: input.documentId ?? null,
    intent: input.intent ?? 'download',
    format: 'pdf',
    businessId: input.businessId ?? null,
    branchId: input.branchId ?? null,
    transport: 'download',
  });
  const jobIds = handle.id ? [handle.id] : [];

  try {
    const res = await fetch(input.sourceUrl);
    if (!res.ok) throw new Error(`archive_fetch_failed_${res.status}`);
    const blob = await res.blob();
    const outcome = toDownload(blob, input.filename);
    if (!outcome.success) throw new Error(outcome.error ?? 'download failed');
    await handle.markSent(null);
    await handle.markAcked();
    return { success: true, jobIds, transport: 'download', copies: 1 };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await handle.markFailed(error);
    return { success: false, error, jobIds, transport: 'download', copies: 1 };
  }
}




/**
 * Open a ledger row for a print the caller will transport itself
 * (the preview dialog owns the browser print dialog lifecycle).
 * Returns a handle whose transitions are no-ops without business context,
 * so interactive printing is never blocked by the audit trail.
 */
export async function openInteractiveJob(args: {
  documentType: string;
  documentId: string | null;
  intent: string;
  format: PrintFormat;
  businessId: string | null;
  branchId?: string | null;
  transport?: PrintTransport;
  correlationId?: string;
}): Promise<JobHandle> {
  return openJob({
    businessId: args.businessId,
    branchId: args.branchId ?? null,
    documentType: args.documentType,
    documentId: args.documentId,
    intent: args.intent,
    format: args.format,
    transport: args.transport ?? pdfTransport(),
    correlationId: args.correlationId ?? newCorrelationId(),
  });
}

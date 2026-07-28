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
  type JobHandle,
  type PrintFormat,
  type PrintTransport,
  type QueuedJob,
} from './jobs';
import { renderSourceDocument, renderDocumentRecord, type RenderedArtifact } from './render';
import { toDevice, toPage, toDownload, pdfTransport, NO_DEVICE_BOUND } from './dispatch';
import { renderLabelPayload, type LabelDispatchInput } from './labelDispatch';
import { enqueueDocumentIntent, type SubmitDocumentIntentResult } from '@/services/documents/submitIntent';
import { supabase } from '@/integrations/supabase/client';
import type { PaperFormatOption } from './pdfUtils';

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
 */
export async function printDocument(req: PrintDocumentRequest): Promise<PrintResult> {
  const correlationId = req.correlationId ?? newCorrelationId();
  let policy: ResolvedPrintPolicy | null = null;
  try {
    policy = await resolvePrintPolicy(req.businessId, req.branchId, req.documentType);
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

  const jobIds: string[] = [];
  const handles: JobHandle[] = [];
  for (let i = 0; i < copies; i++) {
    const handle = await openJob({
      businessId: req.businessId,
      branchId: req.branchId ?? null,
      documentType: req.documentType,
      documentId: req.documentId,
      intent,
      format: medium as PrintFormat,
      transport,
      correlationId,
    });
    handles.push(handle);
    if (handle.id) jobIds.push(handle.id);
  }

  // ---- render once, dispatch N times -------------------------------
  let artifact: RenderedArtifact;
  try {
    artifact = await renderSourceDocument({
      documentType: req.documentType,
      documentId: req.documentId,
      medium,
      paperFormat,
      extraBody: req.extraBody,
      station: req.station ?? null,
      course: req.course ?? null,
      table: req.table ?? null,
      forceRefreshSettings: req.forceRefreshSettings,
    });

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await Promise.all(handles.map((h) => h.markFailed(error)));
    return { success: false, error, jobIds, transport, copies };
  }

  // Sequential on purpose — copy 2 must never overtake copy 1.
  for (const handle of handles) {
    const outcome = await emit(artifact, {
      intent,
      disposition,
      req,
      correlationId,
    });
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
    await handle.markSent(null);
    await handle.markAcked();
  }

  return { success: true, jobIds, transport, copies, artifact };
}

async function emit(
  artifact: RenderedArtifact,
  ctx: {
    intent: string;
    disposition: PrintDisposition;
    req: PrintDocumentRequest;
    correlationId: string;
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
    return toPage(artifact.blob!);
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
  if (!rendered.ok) {
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
  const submitted = await enqueueDocumentIntent({
    documentRecordId: input.documentRecordId,
    scenario: input.scenario,
    triggeredSource: input.triggeredSource ?? 'manual',
  });

  const jobs = await loadJobs(submitted.job_ids);
  // Device resolution needs org context. Call sites pass a document, not a
  // tenant, so resolve it from the job's business when omitted.
  const organizationId =
    input.organizationId ?? (await resolveOrganizationId(jobs[0]?.business_id ?? null));
  let transport: PrintTransport = 'none';
  let printed = 0;
  let lastError: string | undefined;

  for (const job of jobs) {
    if ((job.disposition ?? 'print') !== 'print') continue;
    const outcome = await dispatchQueuedJob(job, organizationId);
    if (outcome === null) continue; // sweeper owns it
    transport = outcome.transport;
    if (outcome.error) lastError = outcome.error;
    else printed += 1;
  }

  return {
    ...submitted,
    success: !lastError,
    error: lastError,
    needsDevice: Boolean(lastError?.startsWith(NO_DEVICE_BOUND)),
    jobIds: submitted.job_ids,
    transport,
    copies: printed,
  };
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
): Promise<{ transport: PrintTransport; error?: string } | null> {
  const handle = await claimForForeground(job);
  if (!handle) return null;

  let transport: PrintTransport = 'none';
  try {
    const medium = job.medium === 'escpos' ? 'escpos' : 'pdf';
    const artifact = job.document_record_id
      ? await renderDocumentRecord({ documentRecordId: job.document_record_id, medium })
      : await renderSourceDocument({
          documentType: job.doc_type ?? 'document',
          documentId: job.doc_id ?? '',
          medium,
        });

    const copies = Math.max(1, job.copies ?? 1);
    for (let i = 0; i < copies; i++) {
      const outcome = artifact.medium === 'pdf' && artifact.blob
        ? await toPage(artifact.blob)
        : await toDevice({
            intentOrRole: job.hardware_role ?? 'receipt',
            op: 'print_raw',
            payload: { bytes: Array.from(artifact.bytes) },
            organizationId,
            businessId: job.business_id,
            idempotencyKey: `${job.id}:${i + 1}`,
            sourceDocType: job.doc_type ?? null,
            sourceDocId: job.doc_id ?? null,
          });
      transport = outcome.transport;
      if (!outcome.success) throw new Error(outcome.error ?? 'dispatch failed');
    }
    await handle.markAcked();
    return { transport };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await handle.markFailed(error);
    return { transport, error };
  }
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

export const PrintService = {
  renderDocumentBlob,
  openInteractiveJob,
  printDocument,
  printLabel,
  printDocumentIntent,
};

// ---------------------------------------------------------------------
// Rendering-only entries (preview surfaces)
// ---------------------------------------------------------------------

/**
 * Produce the PDF a preview surface displays. Preview is a *render*, not
 * a print: no ledger row is opened here, because nothing was committed to
 * paper. When the operator then hits Print inside the preview, that click
 * goes through `openInteractiveJob` + the transport below, so the ledger
 * still covers every physical print.
 */
export async function renderDocumentBlob(
  documentType: string,
  documentId: string,
  opts?: { paperFormat?: PaperFormatOption | null; extraBody?: Record<string, unknown> },
): Promise<Blob> {
  const artifact = await renderSourceDocument({
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

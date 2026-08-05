/**
 * printing/dispatch — the ONE hardware seam for printing.
 *
 * Everything that ends up on physical media leaves the application here,
 * and only here. Two transports exist, chosen by the rendered medium, not
 * by the document type:
 *
 *   - device transport (`toDevice`): the platform resolves the winning
 *     `device_assignments` row for the requested intent via the
 *     server-authoritative `resolve_device` RPC, then `hardwareClient`
 *     routes the bytes to the local agent / Electron main process. The
 *     agent keeps a per-endpoint FIFO queue, which is what makes rapid
 *     consecutive prints come out in click order.
 *   - page transport (`toPage`): the platform print dialog, for PDF on a
 *     desktop/office printer.
 *
 * There is deliberately no "try the other one" fallback. A print that
 * silently lands somewhere the operator did not choose is worse than a
 * visible refusal, so an unbound intent returns `no_device_bound` and the
 * UI routes the operator to Platform → Hardware.
 */
import { execForIntent, NO_DEVICE_BOUND } from '@/services/hardware/execForIntent';
import { printPdfInPage, downloadPdfBlob } from '@/services/printing/pdfUtils';
import type { PrintTransport } from './jobs';

export { NO_DEVICE_BOUND };

export interface DeviceDispatchInput {
  /** Business intent (`receipt`, `label`, `kitchen_ticket`, …) or a bare role. */
  intentOrRole: string;
  op: string;
  payload: unknown;
  organizationId: string | null | undefined;
  businessId?: string | null;
  idempotencyKey?: string;
  sourceDocType?: string | null;
  sourceDocId?: string | null;
  businessEventId?: string | null;
  isReprint?: boolean;
  /** Trace key of the originating print, for the diagnostics waterfall. */
  correlationId?: string;
}

export interface DispatchOutcome {
  success: boolean;
  transport: PrintTransport;
  error?: string;
  assignmentId?: string | null;
}

/** Send bytes/payload to the printer the platform resolves for this intent. */
export async function toDevice(input: DeviceDispatchInput): Promise<DispatchOutcome> {
  const res = await execForIntent({
    intentOrRole: input.intentOrRole,
    op: input.op,
    payload: input.payload,
    organizationId: input.organizationId ?? null,
    businessId: input.businessId ?? null,
    idempotencyKey: input.idempotencyKey,
    sourceDocType: input.sourceDocType ?? null,
    sourceDocId: input.sourceDocId ?? null,
    businessEventId: input.businessEventId ?? null,
    isReprint: input.isReprint,
    correlationId: input.correlationId,
  });
  return {
    success: res.success,
    transport: 'thermal',
    error: res.error,
    assignmentId: res.assignmentId ?? null,
  };
}

/** Print a PDF through the host print dialog (Electron pipe or browser iframe). */
export async function toPage(blob: Blob): Promise<DispatchOutcome> {
  const transport: PrintTransport = isElectron() ? 'pdf-electron' : 'pdf-browser';
  try {
    await printPdfInPage(blob);
    return { success: true, transport };
  } catch (err) {
    return { success: false, transport, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Save the artifact to the operator's downloads folder. */
export function toDownload(blob: Blob, filename: string): DispatchOutcome {
  try {
    downloadPdfBlob(blob, filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
    return { success: true, transport: 'download' };
  } catch (err) {
    return {
      success: false,
      transport: 'download',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function isElectron(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { pos?: { isElectron?: boolean } }).pos?.isElectron)
  );
}

export function pdfTransport(): PrintTransport {
  return isElectron() ? 'pdf-electron' : 'pdf-browser';
}

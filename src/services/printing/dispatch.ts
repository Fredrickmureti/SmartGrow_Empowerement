/**
 * printing/dispatch — the ONE outbound seam for printing.
 *
 * Output leaves the application here, and only here. Two dispositions
 * exist, chosen by what the operator asked for, never by document type:
 *
 *   - page transport (`toPage`): the platform print dialog, for PDF on
 *     whichever printer the operator selected in the OS.
 *   - download (`toDownload`): the artifact is saved as a file.
 *
 * There is deliberately no device/driver transport. This institution
 * prints documents; it does not own a managed printer estate, so the OS
 * printer selection is the only device binding the system knows about.
 */
import { printPdfInPage, downloadPdfBlob } from '@/services/printing/pdfUtils';
import type { PrintTransport } from './jobs';

export interface DispatchOutcome {
  success: boolean;
  transport: PrintTransport;
  error?: string;
  assignmentId?: string | null;
}

export interface PageDispatchOptions {
  /**
   * Phase 5.4 — invoked when the host print dialog has taken the bytes.
   * For paper output that is the terminal moment the system can observe:
   * what the operator then does in the OS dialog is outside our control,
   * so the ledger must not wait for it.
   */
  onHandedToHost?: () => void;
}

export async function toPage(
  blob: Blob,
  opts?: PageDispatchOptions,
): Promise<DispatchOutcome> {
  const transport: PrintTransport = isElectron() ? 'pdf-electron' : 'pdf-browser';
  try {
    await printPdfInPage(blob, { onHandedToHost: opts?.onHandedToHost });
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

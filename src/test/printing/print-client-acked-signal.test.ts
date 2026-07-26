/**
 * Plan P3 Step 4 — ledger completion signal (acked_at).
 *
 * Locks in that successful thermal + PDF dispatches flip the ledger row
 * to `acked` via `print_job_mark_acked_by_id`, and that failed
 * dispatches route through `print_job_mark_failed` instead.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
const printRawBytesMock = vi.fn();
const printLabelBytesMock = vi.fn().mockResolvedValue({ success: true });
const generatePdfMock = vi.fn().mockResolvedValue(new Blob(['pdf'], { type: 'application/pdf' }));
const generateEscPosMock = vi.fn().mockResolvedValue(new Uint8Array([0x1b, 0x40]));
const printPdfInPageMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

vi.mock('@/services/hardware/HardwareClient', () => ({
  hardwareClient: {
    printRawBytes: (...a: unknown[]) => printRawBytesMock(...a),
    printLabelBytes: (...a: unknown[]) => printLabelBytesMock(...a),
  },
}));

vi.mock('@/services/printing/pdfUtils', () => ({
  generateDocumentPdf: (...a: unknown[]) => generatePdfMock(...a),
  generateDocumentEscPosBytes: (...a: unknown[]) => generateEscPosMock(...a),
  printPdfInPage: (...a: unknown[]) => printPdfInPageMock(...a),
  downloadPdfBlob: vi.fn(),
  openPdfInNewTab: vi.fn(),
}));

function seedRpc(renderMode: 'pdf' | 'escpos', copies = 1) {
  let nextId = 1;
  rpcMock.mockImplementation(async (name: string) => {
    if (name === 'print_policies_resolve') {
      return {
        data: [{
          printer_profile_id: null,
          paper_format: 'a4',
          render_mode: renderMode,
          copies,
          auto_print: true,
          ask_user: false,
        }],
        error: null,
      };
    }
    if (name === 'print_job_insert') return { data: `job-${nextId++}`, error: null };
    return { data: null, error: null };
  });
}

function ackCalls() {
  return rpcMock.mock.calls
    .filter((c) => c[0] === 'print_job_mark_acked_by_id')
    .map((c) => (c[1] as { p_id: string }).p_id);
}
function sentCalls() {
  return rpcMock.mock.calls
    .filter((c) => c[0] === 'print_job_mark_sent')
    .map((c) => (c[1] as { p_id: string }).p_id);
}
function failedCalls() {
  return rpcMock.mock.calls
    .filter((c) => c[0] === 'print_job_mark_failed')
    .map((c) => c[1] as { p_id: string; p_error: string });
}

describe('PrintClient — P3 Step 4 ledger acked_at', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    printRawBytesMock.mockReset();
    printLabelBytesMock.mockReset();
    printLabelBytesMock.mockResolvedValue({ success: true });
    printPdfInPageMock.mockClear();
  });

  it('marks thermal single-copy job sent then acked when driver returns success', async () => {
    seedRpc('escpos', 1);
    printRawBytesMock.mockResolvedValue({ success: true });
    const { printClient } = await import('@/services/printing/PrintClient');
    const res = await printClient.print({
      intent: 'receipt',
      documentType: 'pos_receipt',
      documentId: 'txn-1',
      businessId: 'biz-1',
      idempotencyKey: 'click-a',
    });
    expect(res.success).toBe(true);
    expect(sentCalls()).toContain('job-1');
    expect(ackCalls()).toEqual(['job-1']);
    expect(failedCalls()).toHaveLength(0);
  });

  it('marks thermal job failed (no ack) when driver returns success:false', async () => {
    seedRpc('escpos', 1);
    printRawBytesMock.mockResolvedValue({ success: false, error: 'offline' });
    const { printClient } = await import('@/services/printing/PrintClient');
    const res = await printClient.print({
      intent: 'receipt',
      documentType: 'pos_receipt',
      documentId: 'txn-2',
      businessId: 'biz-1',
      idempotencyKey: 'click-b',
    });
    expect(res.success).toBe(false);
    expect(ackCalls()).toHaveLength(0);
    expect(failedCalls()).toEqual([{ p_id: 'job-1', p_error: 'offline' }]);
  });

  it('marks PDF single-copy job sent then acked after the print dialog resolves', async () => {
    seedRpc('pdf', 1);
    const { printClient } = await import('@/services/printing/PrintClient');
    const res = await printClient.print({
      intent: 'a4_document',
      documentType: 'invoice',
      documentId: 'inv-1',
      businessId: 'biz-1',
      idempotencyKey: 'click-c',
    });
    expect(res.success).toBe(true);
    expect(sentCalls()).toContain('job-1');
    expect(ackCalls()).toEqual(['job-1']);
  });

  it('multi-copy PDF: acks each child then the parent', async () => {
    seedRpc('pdf', 3);
    const { printClient } = await import('@/services/printing/PrintClient');
    const res = await printClient.print({
      intent: 'a4_document',
      documentType: 'invoice',
      documentId: 'inv-2',
      businessId: 'biz-1',
      idempotencyKey: 'click-d',
    });
    expect(res.success).toBe(true);
    // job-1 = parent, job-2..4 = child copies
    const acks = ackCalls();
    expect(acks).toContain('job-2');
    expect(acks).toContain('job-3');
    expect(acks).toContain('job-4');
    expect(acks).toContain('job-1');
  });

  it('recordInteractivePrint exposes a markAcked() handle that calls the by-id RPC', async () => {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === 'print_job_insert') return { data: 'job-99', error: null };
      return { data: null, error: null };
    });
    const { printClient } = await import('@/services/printing/PrintClient');
    const ledger = await printClient.recordInteractivePrint({
      documentType: 'invoice',
      documentId: 'inv-9',
      intent: 'a4_document',
      format: 'pdf',
      businessId: 'biz-1',
      idempotencyKey: 'click-e',
    });
    expect(ledger.jobId).toBe('job-99');
    await ledger.markAcked();
    expect(ackCalls()).toEqual(['job-99']);
  });
});

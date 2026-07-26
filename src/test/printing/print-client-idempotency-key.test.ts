/**
 * Plan P3 Step 1 — per-click idempotency key contract.
 *
 * Locks in that:
 *   1. `PrintRequest.idempotencyKey`, when supplied, is used verbatim as
 *      the `p_correlation_id` argument to the ledger insert RPC — replacing
 *      the legacy 2-second `(docType:docId:intent:bucket)` fallback.
 *   2. When the caller omits the key, the legacy bucket derivation still
 *      applies (backwards compatibility for un-migrated call sites).
 *   3. `recordInteractivePrint({ ... idempotencyKey })` forwards the key
 *      through to the same RPC arg, so the dialog and the direct-print
 *      path collapse on the same `(business_id, correlation_id)` uniqueness.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
const printRawBytesMock = vi.fn().mockResolvedValue({ success: true });
const generatePdfMock = vi.fn().mockResolvedValue(new Blob(['pdf'], { type: 'application/pdf' }));
const generateEscPosMock = vi.fn().mockResolvedValue(new Uint8Array([0x1b, 0x40]));
const printPdfInPageMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

vi.mock('@/services/hardware/HardwareClient', () => ({
  hardwareClient: {
    printRawBytes: (...a: unknown[]) => printRawBytesMock(...a),
    printLabelBytes: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('@/services/printing/pdfUtils', () => ({
  generateDocumentPdf: (...a: unknown[]) => generatePdfMock(...a),
  generateDocumentEscPosBytes: (...a: unknown[]) => generateEscPosMock(...a),
  printPdfInPage: (...a: unknown[]) => printPdfInPageMock(...a),
  downloadPdfBlob: vi.fn(),
  openPdfInNewTab: vi.fn(),
}));

function insertCallArgs() {
  const call = rpcMock.mock.calls.find((c) => c[0] === 'print_job_insert');
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

beforeEach(async () => {
  rpcMock.mockReset();
  // Default: policy resolver returns an auto-print PDF policy, ledger
  // insert returns a job id, mark_sent/mark_failed just succeed.
  rpcMock.mockImplementation(async (name: string) => {
    if (name === 'print_policies_resolve') {
      return {
        data: [{ printer_profile_id: null, paper_format: 'a4', render_mode: 'pdf', copies: 1, auto_print: true, ask_user: false }],
        error: null,
      };
    }
    if (name === 'print_job_insert') return { data: 'job-1', error: null };
    return { data: null, error: null };
  });
  printRawBytesMock.mockClear();
  generatePdfMock.mockClear();
  generateEscPosMock.mockClear();
  printPdfInPageMock.mockClear();
  const { printClient } = await import('@/services/printing/PrintClient');
  printClient.invalidatePolicyCache();
});

describe('PrintClient — per-click idempotency key (Plan P3 Step 1)', () => {
  it('uses PrintRequest.idempotencyKey as the ledger correlation id', async () => {
    const { printClient } = await import('@/services/printing/PrintClient');
    const key = '11111111-1111-4111-8111-111111111111';
    await printClient.print({
      intent: 'a4_document',
      documentType: 'invoice',
      documentId: 'inv-idemp-1',
      businessId: 'biz-1',
      branchId: null,
      idempotencyKey: key,
    });
    expect(insertCallArgs().p_correlation_id).toBe(key);
  });

  it('falls back to legacy bucket derivation when no key is supplied', async () => {
    const { printClient } = await import('@/services/printing/PrintClient');
    await printClient.print({
      intent: 'a4_document',
      documentType: 'invoice',
      documentId: 'inv-legacy',
      businessId: 'biz-1',
      branchId: null,
    });
    const corr = String(insertCallArgs().p_correlation_id ?? '');
    // Legacy shape: `${docType}:${docId}:${intent}:${bucket}`
    expect(corr.startsWith('invoice:inv-legacy:a4_document:')).toBe(true);
    expect(corr).not.toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('recordInteractivePrint forwards the key to the ledger insert', async () => {
    const { printClient } = await import('@/services/printing/PrintClient');
    const key = '22222222-2222-4222-8222-222222222222';
    const handle = await printClient.recordInteractivePrint({
      documentType: 'invoice',
      documentId: 'inv-dialog-1',
      intent: 'a4_document',
      format: 'pdf',
      businessId: 'biz-1',
      branchId: null,
      idempotencyKey: key,
    });
    expect(handle.jobId).toBe('job-1');
    expect(insertCallArgs().p_correlation_id).toBe(key);
  });

  it('two calls with the SAME key produce the SAME correlation id (collapse target)', async () => {
    const { printClient } = await import('@/services/printing/PrintClient');
    const key = '33333333-3333-4333-8333-333333333333';
    await printClient.print({
      intent: 'a4_document', documentType: 'invoice', documentId: 'inv-x',
      businessId: 'biz-1', branchId: null, idempotencyKey: key,
    });
    await printClient.print({
      intent: 'a4_document', documentType: 'invoice', documentId: 'inv-x',
      businessId: 'biz-1', branchId: null, idempotencyKey: key,
    });
    const inserts = rpcMock.mock.calls.filter((c) => c[0] === 'print_job_insert');
    expect(inserts).toHaveLength(2);
    expect(inserts[0][1].p_correlation_id).toBe(key);
    expect(inserts[1][1].p_correlation_id).toBe(key);
  });
});

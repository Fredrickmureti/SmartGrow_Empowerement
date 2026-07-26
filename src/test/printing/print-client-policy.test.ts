/**
 * Wave B1 Step 2 — runtime behaviour test for `PrintClient.print()` policy
 * resolution. Verifies the ADR-0026 contract:
 *   - When `businessId` is supplied, the RPC is consulted.
 *   - `ask_user: true` short-circuits with `transport: 'ask_user'`.
 *   - `render_mode` overrides the intent-derived format.
 *   - When `businessId` is omitted, legacy intent-only routing applies.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
const printRawBytesMock = vi.fn().mockResolvedValue(undefined);
const printLabelBytesMock = vi.fn().mockResolvedValue(undefined);
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

beforeEach(async () => {
  rpcMock.mockReset();
  printRawBytesMock.mockClear();
  printLabelBytesMock.mockClear();
  generatePdfMock.mockClear();
  generateEscPosMock.mockClear();
  printPdfInPageMock.mockClear();
  const { printClient } = await import('@/services/printing/PrintClient');
  printClient.invalidatePolicyCache();
});


describe('PrintClient.print policy resolution (ADR-0026 Step 2)', () => {
  it('short-circuits with ask_user when policy returns ask_user=true', async () => {
    rpcMock.mockResolvedValue({
      data: [{ printer_profile_id: null, paper_format: 'a4', render_mode: 'pdf', copies: 1, auto_print: false, ask_user: true }],
      error: null,
    });
    const { printClient } = await import('@/services/printing/PrintClient');
    const result = await printClient.print({
      intent: 'a4_document',
      documentType: 'invoice',
      documentId: 'inv-1',
      businessId: 'biz-1',
      branchId: null,
    });
    expect(result.transport).toBe('ask_user');
    expect(result.success).toBe(false);
    expect(result.policy?.askUser).toBe(true);
    expect(generatePdfMock).not.toHaveBeenCalled();
    expect(printRawBytesMock).not.toHaveBeenCalled();
  });

  it('routes to thermal when policy.render_mode=escpos and ask_user=false', async () => {
    rpcMock.mockResolvedValue({
      data: [{ printer_profile_id: 'pp-1', paper_format: '80mm', render_mode: 'escpos', copies: 1, auto_print: true, ask_user: false }],
      error: null,
    });
    const { printClient } = await import('@/services/printing/PrintClient');
    const result = await printClient.print({
      intent: 'a4_document', // intent says PDF, policy overrides to ESC/POS
      documentType: 'invoice',
      documentId: 'inv-2',
      businessId: 'biz-1',
      branchId: 'br-1',
    });
    expect(result.transport).toBe('thermal');
    expect(result.success).toBe(true);
    expect(generateEscPosMock).toHaveBeenCalledWith('invoice', 'inv-2');
    expect(printRawBytesMock).toHaveBeenCalled();
  });

  it('falls back to intent-only routing when businessId is omitted', async () => {
    const { printClient } = await import('@/services/printing/PrintClient');
    const result = await printClient.print({
      intent: 'a4_document',
      documentType: 'invoice',
      documentId: 'inv-3',
    });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(generatePdfMock).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('tolerates RPC errors and falls back to intent-only routing', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { printClient } = await import('@/services/printing/PrintClient');
    printClient.invalidatePolicyCache();
    const result = await printClient.print({
      intent: 'a4_document',
      documentType: 'invoice',
      documentId: 'inv-4',
      businessId: 'biz-1',
    });
    expect(generatePdfMock).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.policy).toBeNull();
  });

  // ── Wave B1 Step 2.5 corrections ─────────────────────────────────
  it('does NOT route to ask_user when auto_print=false (only RPC ask_user matters)', async () => {
    rpcMock.mockResolvedValue({
      data: [{ printer_profile_id: 'pp-x', paper_format: 'a4', render_mode: 'pdf', copies: 1, auto_print: false, ask_user: false }],
      error: null,
    });
    const { printClient } = await import('@/services/printing/PrintClient');
    printClient.invalidatePolicyCache();
    const result = await printClient.print({
      intent: 'a4_document',
      documentType: 'invoice',
      documentId: 'inv-noask',
      businessId: 'biz-1',
      branchId: 'br-1',
    });
    expect(result.transport).not.toBe('ask_user');
    expect(result.success).toBe(true);
    expect(generatePdfMock).toHaveBeenCalled();
  });

  it('honours policy.copies by fanning out the transport call', async () => {
    rpcMock.mockResolvedValue({
      data: [{ printer_profile_id: 'pp-1', paper_format: '80mm', render_mode: 'escpos', copies: 3, auto_print: true, ask_user: false }],
      error: null,
    });
    const { printClient } = await import('@/services/printing/PrintClient');
    printClient.invalidatePolicyCache();
    await printClient.print({
      intent: 'receipt',
      documentType: 'pos_receipt',
      documentId: 'tx-9',
      businessId: 'biz-1',
      branchId: 'br-1',
    });
    expect(printRawBytesMock).toHaveBeenCalledTimes(3);
  });

  it('caches resolved policies so repeated prints hit the RPC once', async () => {
    rpcMock.mockResolvedValue({
      data: [{ printer_profile_id: 'pp-1', paper_format: '80mm', render_mode: 'escpos', copies: 1, auto_print: true, ask_user: false }],
      error: null,
    });
    const { printClient } = await import('@/services/printing/PrintClient');
    printClient.invalidatePolicyCache();
    const req = {
      intent: 'receipt' as const,
      documentType: 'pos_receipt',
      documentId: 'tx-cache',
      businessId: 'biz-cache',
      branchId: 'br-cache',
    };
    await printClient.print(req);
    await printClient.print({ ...req, documentId: 'tx-cache-2' });
    await printClient.print({ ...req, documentId: 'tx-cache-3' });
    // Count only policy-resolve RPCs; print_job_insert/mark_sent are called
    // per print and are not what this test is measuring (ADR-0090).
    const resolveCalls = () =>
      rpcMock.mock.calls.filter((c) => c[0] === 'print_policies_resolve').length;
    expect(resolveCalls()).toBe(1);
    printClient.invalidatePolicyCache();
    await printClient.print({ ...req, documentId: 'tx-cache-4' });
    expect(resolveCalls()).toBe(2);
  });
});


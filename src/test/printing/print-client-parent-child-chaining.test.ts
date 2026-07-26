/**
 * Plan P3 Step 2 — parent/child chaining on `print_jobs`.
 *
 * Locks in that a multi-copy fan-out inserts one parent container row
 * and one child row per copy, with `p_parent_job_id` set on children.
 * Single-copy jobs keep the legacy shape: one row, no child, no parent.
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

function insertCalls() {
  return rpcMock.mock.calls
    .filter((c) => c[0] === 'print_job_insert')
    .map((c) => c[1] as Record<string, unknown>);
}

function seedRpc(policy: { copies: number; render_mode?: 'pdf' | 'escpos' }) {
  let nextId = 1;
  rpcMock.mockImplementation(async (name: string) => {
    if (name === 'print_policies_resolve') {
      return {
        data: [{
          printer_profile_id: null,
          paper_format: 'a4',
          render_mode: policy.render_mode ?? 'pdf',
          copies: policy.copies,
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

beforeEach(async () => {
  rpcMock.mockReset();
  printRawBytesMock.mockClear();
  generatePdfMock.mockClear();
  generateEscPosMock.mockClear();
  printPdfInPageMock.mockClear();
  const { printClient } = await import('@/services/printing/PrintClient');
  printClient.invalidatePolicyCache();
});

describe('PrintClient — parent/child chaining (Plan P3 Step 2)', () => {
  it('single-copy job inserts exactly one row with no parent link', async () => {
    seedRpc({ copies: 1 });
    const { printClient } = await import('@/services/printing/PrintClient');
    await printClient.print({
      intent: 'a4_document',
      documentType: 'invoice',
      documentId: 'inv-1',
      businessId: 'biz-1',
      branchId: null,
      idempotencyKey: 'key-single',
    });
    const inserts = insertCalls();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].p_parent_job_id).toBeNull();
    expect(inserts[0].p_correlation_id).toBe('key-single');
  });

  it('multi-copy fan-out inserts parent + N children with parent_job_id set', async () => {
    seedRpc({ copies: 3 });
    const { printClient } = await import('@/services/printing/PrintClient');
    await printClient.print({
      intent: 'a4_document',
      documentType: 'invoice',
      documentId: 'inv-multi',
      businessId: 'biz-1',
      branchId: null,
      idempotencyKey: 'key-multi',
    });
    const inserts = insertCalls();
    // 1 parent + 3 children
    expect(inserts).toHaveLength(4);

    const [parent, ...children] = inserts;
    expect(parent.p_parent_job_id).toBeNull();
    expect(parent.p_correlation_id).toBe('key-multi');

    // Children all link to the parent's job id (`job-1`) and carry
    // unique per-copy correlation ids so the DB uniqueness holds.
    for (let i = 0; i < children.length; i++) {
      expect(children[i].p_parent_job_id).toBe('job-1');
      expect(children[i].p_correlation_id).toBe(`key-multi:copy:${i + 1}`);
    }
    const corrs = new Set(children.map((c) => c.p_correlation_id));
    expect(corrs.size).toBe(children.length);

    // The physical print happened once per copy.
    expect(printPdfInPageMock).toHaveBeenCalledTimes(3);
  });

  it('rapid double-click regenerates identical child keys so DB uniqueness collapses copies', async () => {
    seedRpc({ copies: 2 });
    const { printClient } = await import('@/services/printing/PrintClient');
    const req = {
      intent: 'a4_document' as const,
      documentType: 'invoice',
      documentId: 'inv-dbl',
      businessId: 'biz-1',
      branchId: null,
      idempotencyKey: 'key-dbl',
    };
    await printClient.print(req);
    await printClient.print(req);
    const inserts = insertCalls();
    // Two clicks × (1 parent + 2 children) = 6 attempts
    expect(inserts).toHaveLength(6);
    const childCorrs = inserts
      .filter((c) => c.p_parent_job_id !== null)
      .map((c) => c.p_correlation_id);
    // First-click and second-click children share correlation ids —
    // the DB unique index on (business_id, correlation_id) collapses them.
    expect(childCorrs).toEqual([
      'key-dbl:copy:1', 'key-dbl:copy:2',
      'key-dbl:copy:1', 'key-dbl:copy:2',
    ]);
  });
});

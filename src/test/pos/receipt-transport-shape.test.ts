/**
 * Receipt transport-shape guardrail.
 *
 * Locks the architectural rule: the shape of a receipt document at print
 * time must follow the destination transport, not the on-screen preview.
 *   - Thermal-bound sale  → ESC/POS bytes (no PDF, no dialog).
 *   - No thermal printer  → server PDF on A4/Letter (never a 80mm strip
 *                            handed to Chrome's native print dialog).
 *
 * Regression this catches: printing a `pos_receipt` at its policy paper
 * (80mm) into a browser print dialog produced the "tall blank strip" the
 * cashier complained about — competitors (Enerpize, Odoo) always render
 * a sheet-shaped invoice on the no-thermal fallback path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/hardware/HardwareClient', () => ({
  hardwareClient: {
    printRawBytes: vi.fn(async () => ({ success: true })),
    printLabelBytes: vi.fn(async () => ({ success: true })),
  },
}));

const generateDocumentPdf = vi.fn(async () => new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: 'application/pdf' }));
const generateDocumentEscPosBytes = vi.fn(async () => new Uint8Array([0x1b, 0x40]));
const printPdfInPage = vi.fn(async () => undefined);

vi.mock('@/services/printing/pdfUtils', () => ({
  generateDocumentPdf: (...args: unknown[]) => generateDocumentPdf(...(args as [])),
  generateDocumentEscPosBytes: (...args: unknown[]) => generateDocumentEscPosBytes(...(args as [])),
  printPdfInPage: (...args: unknown[]) => printPdfInPage(...(args as [])),
  downloadPdfBlob: vi.fn(),
  openPdfInNewTab: vi.fn(),
}));

describe('receipt transport shape', () => {
  beforeEach(() => {
    generateDocumentPdf.mockClear();
    generateDocumentEscPosBytes.mockClear();
    printPdfInPage.mockClear();
  });

  it('renders A4 (not 80mm) when the receipt intent falls back to PDF', async () => {
    const { printClient } = await import('@/services/printing/PrintClient');
    const res = await printClient.print({
      intent: 'receipt',
      documentType: 'pos_receipt',
      documentId: 'txn-123',
      format: 'pdf', // force the no-thermal path
    });
    expect(res.success).toBe(true);
    expect(res.transport).toMatch(/pdf-/);
    expect(generateDocumentPdf).toHaveBeenCalledWith(
      'pos_receipt',
      'txn-123',
      expect.objectContaining({ paperFormat: 'a4' }),
    );
  });

  it('sends ESC/POS bytes (no PDF) when the receipt intent uses thermal transport', async () => {
    const { printClient } = await import('@/services/printing/PrintClient');
    const res = await printClient.print({
      intent: 'receipt',
      documentType: 'pos_receipt',
      documentId: 'txn-456',
      format: 'escpos',
    });
    expect(res.success).toBe(true);
    expect(res.transport).toBe('thermal');
    expect(generateDocumentEscPosBytes).toHaveBeenCalledWith('pos_receipt', 'txn-456');
    expect(generateDocumentPdf).not.toHaveBeenCalled();
  });

  it('never forces A4 on non-receipt PDF documents (invoices, statements, etc.)', async () => {
    const { printClient } = await import('@/services/printing/PrintClient');
    await printClient.print({
      intent: 'a4_document',
      documentType: 'invoice',
      documentId: 'inv-1',
      format: 'pdf',
    });
    // Invoices already come out as A4 from their template; PrintClient
    // must not override the resolved policy paper format on this path.
    expect(generateDocumentPdf).toHaveBeenCalledWith('invoice', 'inv-1', undefined);
  });
});

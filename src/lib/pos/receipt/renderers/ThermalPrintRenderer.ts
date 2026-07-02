/**
 * Stage X2 — thermal printer (ESC/POS) renderer.
 *
 * Pure dispatch wrapper: fetches bytes from the unified server engine
 * (`generate-document` with `format=escpos`) and streams them through
 * the hardware proxy. NO React, NO toasts.
 *
 * Architecture rule: this file is the ONE allowed call site of
 * generateDocumentEscPosBytes inside the POS UI layer (the
 * pos-receipt-renderer-contract test enforces this).
 */
import { generateDocumentEscPosBytes } from "@/services/printing/pdfUtils";
import type { ReceiptDocumentModel } from "../ReceiptDocumentModel";

export interface ThermalPrintResult {
  success: boolean;
  error?: string;
  bytesWritten?: number;
}

export interface PrintRawBytesFn {
  (bytes: Uint8Array): Promise<{ success: boolean; error?: string; bytesWritten?: number }>;
}

/**
 * Render `model` to ESC/POS bytes (server-side) and stream them to the
 * physical printer via the hardware proxy.
 */
export async function printThermal(
  model: ReceiptDocumentModel,
  printRawBytes: PrintRawBytesFn,
): Promise<ThermalPrintResult> {
  try {
    const bytes = await generateDocumentEscPosBytes(
      "pos_receipt",
      model.meta.transaction_id,
    );
    const res = await printRawBytes(bytes);
    return {
      success: res.success,
      error: res.error,
      bytesWritten: res.bytesWritten,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
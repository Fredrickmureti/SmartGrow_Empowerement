/**
 * Browser adapter for the canonical receipt Line[] AST producer.
 *
 * Receipt structure lives exclusively in the shared `lines.ts` module.
 * Preview, thermal PDF and ESC/POS cannot independently add or reorder rows.
 */
import {
  buildReceiptLines as buildCanonicalReceiptLines,
  type BuildReceiptLinesInput as CanonicalInput,
  type LineMeta,
  type ReceiptLinesResult,
} from "../../../../supabase/functions/_shared/receipt/lines";
import type { ExtendedReceiptSettings, ReceiptCompanyData, ReceiptTransactionData } from "@/types/receipt";

export type { LineMeta };
export type BuildReceiptLinesResult = ReceiptLinesResult;

export interface BuildReceiptLinesInput {
  settings: ExtendedReceiptSettings;
  company: ReceiptCompanyData;
  transaction: ReceiptTransactionData;
}

export function buildReceiptLines(input: BuildReceiptLinesInput): BuildReceiptLinesResult {
  return buildCanonicalReceiptLines(input as unknown as CanonicalInput);
}

/** Sample transaction used by the Settings preview when no live data exists. */
export const SAMPLE_TRANSACTION: ReceiptTransactionData = {
  id: "preview-001",
  transaction_number: "TXN-2026-0001",
  created_at: new Date().toISOString(),
  subtotal: 2500,
  tax_amount: 400,
  discount_amount: 200,
  total_amount: 2700,
  amount_tendered: 3000,
  change_due: 300,
  customer_name: "John Doe",
  cashier_name: "Jane Smith",
  register_id: "REG-01",
  items: [
    { product_name: "Premium Coffee Blend 250g", sku: "COF-001", quantity: 2, unit_price: 850, discount_amount: 100, line_total: 1600 },
    { product_name: "Organic Green Tea", sku: "TEA-042", quantity: 1, unit_price: 650, discount_amount: 0, line_total: 650 },
    { product_name: "Chocolate Croissant", sku: "BAK-015", quantity: 3, unit_price: 150, discount_amount: 100, line_total: 350 },
  ],
  payments: [{ payment_method: "cash", amount: 3000 }],
  etims_cu_number: "CU-123456789",
  etims_qr_data: "https://etims.kra.go.ke/verify/123456",
};

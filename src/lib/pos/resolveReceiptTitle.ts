/**
 * Browser-safe re-export of the canonical POS title resolver.
 *
 * Mirrors `supabase/functions/_shared/pos/resolveReceiptTitle.ts` byte-for-
 * byte (manually kept in sync). Used by `ReceiptDocumentModel` so the
 * on-screen preview / customer display / saved-PDF title agrees with what
 * the ESC/POS bytes carry — no more "screen says SALES RECEIPT, paper
 * says INVOICE" drift.
 */

export interface ResolveTitleInput {
  total: number | null | undefined;
  amount_paid: number | null | undefined;
  payments: Array<{ payment_method?: string | null; amount?: number | null }> | null | undefined;
  tax_amount?: number | null;
  etims_cu_number?: string | null;
  is_voided?: boolean | null;
  is_refund?: boolean | null;
  is_reprint?: boolean | null;
  legacy_title_mode?: boolean | null;
}

export interface ResolvedTitle {
  title: string;
  kind: "sales_receipt" | "tax_invoice" | "invoice" | "credit_note" | "void";
}

export function resolveReceiptTitle(input: ResolveTitleInput): ResolvedTitle {
  const total = Number(input.total ?? 0);
  const paid = Number(input.amount_paid ?? 0);
  const payments = Array.isArray(input.payments) ? input.payments : [];
  const hasCreditTender = payments.some((p) => p?.payment_method === "credit");
  const tax = Number(input.tax_amount ?? 0);
  const isFiscalized = !!(input.etims_cu_number && String(input.etims_cu_number).trim());
  const legacy = !!input.legacy_title_mode;

  if (input.is_refund || total < 0) {
    const base: ResolvedTitle = { title: "CREDIT NOTE", kind: "credit_note" };
    if (input.is_voided) return { title: `VOID — ${base.title}`, kind: "void" };
    return input.is_reprint ? { ...base, title: `${base.title} (REPRINT)` } : base;
  }

  const balanceDue = total - paid;
  const isOnAccount = (hasCreditTender && paid + 0.005 < total) || balanceDue > 0.005;

  let base: ResolvedTitle;
  if (isOnAccount) {
    base = { title: "INVOICE", kind: "invoice" };
  } else if (isFiscalized && tax > 0 && !legacy) {
    base = { title: "TAX INVOICE", kind: "tax_invoice" };
  } else {
    base = { title: "SALES RECEIPT", kind: "sales_receipt" };
  }

  if (input.is_voided) return { title: `VOID — ${base.title}`, kind: "void" };
  return input.is_reprint ? { ...base, title: `${base.title} (REPRINT)` } : base;
}

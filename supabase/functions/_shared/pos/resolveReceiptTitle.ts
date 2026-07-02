/**
 * Single source of truth for the printed/rendered title of a POS document.
 *
 * Professional POS terminology rules (see plan.md §2):
 *   - SALES RECEIPT  — fully-paid sale (cash, card, mobile, mixed) with no
 *                      outstanding balance.
 *   - TAX INVOICE    — same as SALES RECEIPT but the merchant is fiscalized
 *                      (e.g. KRA eTIMS CU number present) AND tax > 0. In
 *                      that case the receipt IS legally an invoice.
 *   - INVOICE        — sale on account: any unpaid balance after applying
 *                      payments, OR a `credit` payment line that does not
 *                      cover the full total.
 *   - CREDIT NOTE    — refund / negative-total document.
 *   - VOID           — voided sale (prefix on the original title).
 *   - REPRINT        — re-issued copy (suffix on the resolved title).
 *
 * Pure: no Supabase / no I/O. Re-used by both the snapshot path and the
 * live-fetch path in `generate-document`.
 */

export interface ResolveTitleInput {
  total: number | null | undefined;
  /** Sum of NON-credit payments actually collected at the till. */
  amount_paid: number | null | undefined;
  /** Raw payment rows; used to detect a `credit` tender. */
  payments: Array<{ payment_method?: string | null; amount?: number | null }> | null | undefined;
  tax_amount?: number | null;
  /** eTIMS CU number — when present we treat the org as fiscalized. */
  etims_cu_number?: string | null;
  is_voided?: boolean | null;
  is_refund?: boolean | null;
  is_reprint?: boolean | null;
  /**
   * Phase F — when true, fully-paid sales always print "SALES RECEIPT"
   * (TAX INVOICE promotion is suppressed). On-account sales still title
   * "INVOICE" — the legal A/R term is non-negotiable. Refund / void
   * decorations are unaffected.
   */
  legacy_title_mode?: boolean | null;
}

export interface ResolvedTitle {
  /** The string to print as the document title. */
  title: string;
  /** Machine-readable category, useful for tests / future routing. */
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

  // Refund / credit note (negative total) — independent of payment mix.
  if (input.is_refund || total < 0) {
    const base: ResolvedTitle = { title: "CREDIT NOTE", kind: "credit_note" };
    if (input.is_voided) return { title: `VOID — ${base.title}`, kind: "void" };
    return input.is_reprint ? { ...base, title: `${base.title} (REPRINT)` } : base;
  }

  // On-account sale: explicit credit tender with shortfall, OR positive
  // unpaid balance.
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

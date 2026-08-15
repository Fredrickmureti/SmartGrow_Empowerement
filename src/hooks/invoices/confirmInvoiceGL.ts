/**
 * Invoice confirmation seam.
 *
 * Sales domain wave, Phase 6.1: GL account resolution is a SERVER
 * responsibility. `_confirm_invoice_core` resolves the receivable account
 * (customer override > canonical default), the per-line revenue account
 * (`resolve_product_gl_account`), output tax and discount accounts, builds the
 * journal lines and posts them — all inside one transaction. The browser no
 * longer computes or sends journal lines; `confirm_invoice_atomic` rejects
 * client-supplied lines outright.
 *
 * COGS is NOT posted at confirmation. It posts at goods issue in
 * `complete_delivery_atomic` (ADR 0026).
 */
import { supabase } from "@/integrations/supabase/client";
import type { Invoice } from "../useInvoices";

interface ConfirmInvoiceGLDeps {
  /** Deprecated: account resolution now happens on the server. Ignored. */
  postToGL?: unknown;
  /** Deprecated: server raises an actionable error when a mapping is missing. */
  hasRequiredAccounts?: () => boolean;
  /** Deprecated: superseded by server-side resolution. */
  getInvoiceAccountMappings?: () => unknown;
  /** Deprecated: superseded by server-side resolution. */
  systemDefaults?: unknown;
  logAction: (opts: {
    action: "confirmed";
    entityType: "invoice";
    entityId: string;
    entityName: string;
    oldValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
    changesSummary?: string;
  }) => void;
  userId?: string;
  releaseStock?: boolean;
}

/**
 * Confirms an invoice (draft → sent) and posts its journal entry atomically.
 * Returns the journal entry ID on success.
 */
export async function confirmInvoiceAndPostGL(
  invoice: Invoice,
  deps: ConfirmInvoiceGLDeps,
): Promise<string | null> {
  if (invoice.status !== "draft") {
    throw new Error("Only draft invoices can be confirmed");
  }

  // Default direct-invoice workflow releases stock immediately through an
  // auto-created Delivery Note, so quantity changes stay movement-based.
  const releaseStock = deps.releaseStock !== false;

  // `p_final_status: 'sent'` makes the RPC the single writer of the canonical
  // post-confirmation status (Odoo "open" / Xero "awaiting payment").
  const { data, error } = releaseStock
    ? await supabase.rpc("confirm_invoice_and_release_stock_atomic" as any, {
        p_invoice_id: invoice.id,
        p_user_id: deps.userId || null,
        p_release_stock: true,
        // Phase 6b: issue from the warehouse recorded on the invoice, so the
        // stock that leaves is the stock the operator was shown.
        p_warehouse_id: invoice.warehouse_id ?? null,
        p_final_status: "sent",
      })
    : await supabase.rpc("confirm_invoice_atomic" as any, {
        p_invoice_id: invoice.id,
        p_user_id: deps.userId || null,
        p_final_status: "sent",
      });

  if (error) {
    const rawMsg = error.message || "Unknown error";
    const looksLikeMappingIssue = /account|mapping|null value in column "account_id"|not.*configured/i.test(rawMsg);
    const hint = looksLikeMappingIssue ? " Check your account mappings." : "";
    throw new Error(`Invoice confirmation failed: ${rawMsg}.${hint}`);
  }

  const result = data as { success: boolean; journal_entry_id: string; stock_released?: boolean };
  if (!result?.success) {
    throw new Error("Invoice confirmation failed: server returned no success flag");
  }

  deps.logAction({
    action: "confirmed",
    entityType: "invoice",
    entityId: invoice.id,
    entityName: invoice.invoice_number,
    oldValues: { status: "draft" },
    newValues: { status: "confirmed" },
    changesSummary: releaseStock
      ? `Confirmed invoice ${invoice.invoice_number}, posted to GL, and released stock through delivery`
      : `Confirmed invoice ${invoice.invoice_number} and posted to GL`,
  });

  return result.journal_entry_id;
}

/**
 * Shared invoice confirmation + GL posting logic.
 *
 * Sales audit Phase 3 (Odoo parity):
 * Status flip + JE posting + JE link now happen inside ONE database
 * transaction via `confirm_invoice_atomic`. Account resolution stays
 * client-side (so we keep contact-overrides, per-product COGS, heuristic
 * fallbacks) — the client builds the pre-resolved JE entries and the
 * server posts them atomically.
 */
import { supabase } from "@/integrations/supabase/client";
import type { Invoice } from "../useInvoices";
import { resolveLineAccounts, groupByAccount, type ProductAccountInfo } from "@/lib/resolveProductAccounts";

interface InvoiceLineWithProduct {
  product_id: string | null;
  quantity: number;
  unit_price: number;
  line_total: number;
  tax_amount: number;
  product?: ProductAccountInfo | null;
}

interface ConfirmInvoiceGLDeps {
  // Kept for signature compatibility; postToGL is no longer used (atomic RPC handles posting).
  postToGL?: unknown;
  hasRequiredAccounts: () => boolean;
  getInvoiceAccountMappings: () => {
    receivable_account_id: string | null;
    revenue_account_id: string | null;
    tax_liability_account_id: string | null | undefined;
  };
  systemDefaults: import("../useDefaultAccounts").DefaultAccountMappings;
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

interface JELine {
  account_id: string;
  debit: number;
  credit: number;
  description?: string;
  contact_id?: string | null;
}

async function fetchInvoiceLinesWithProducts(invoiceId: string): Promise<InvoiceLineWithProduct[]> {
  const { data: items, error } = await supabase
    .from("invoice_items")
    .select("product_id, quantity, unit_price, line_total, tax_amount")
    .eq("invoice_id", invoiceId);

  if (error || !items?.length) return [];

  const productIds = items.filter(i => i.product_id).map(i => i.product_id!);
  let productMap: Record<string, ProductAccountInfo> = {};

  if (productIds.length > 0) {
    const { data: products } = await supabase
      .from("products")
      .select("id, sales_account_id, cogs_account_id, inventory_account_id, cost_price, track_inventory")
      .in("id", productIds);
    if (products) {
      for (const p of products) productMap[p.id] = p as ProductAccountInfo;
    }
  }

  return items.map(item => ({
    ...item,
    tax_amount: Number(item.tax_amount ?? 0),
    product: item.product_id ? productMap[item.product_id] || null : null,
  }));
}

async function fetchCustomerDefaults(contactId: string | null): Promise<{
  default_receivable_account_id?: string | null;
}> {
  if (!contactId) return {};
  const { data } = await supabase
    .from("contacts")
    .select("default_receivable_account_id")
    .eq("id", contactId)
    .maybeSingle();
  return data || {};
}

/**
 * Confirms an invoice (draft → confirmed) and posts to the General Ledger
 * atomically via `confirm_invoice_atomic` RPC.
 *
 * The client resolves all accounts (contact override, per-product COGS,
 * system defaults) and builds the JE entries. The DB function does the
 * status flip + JE post + JE link in one transaction — no partial state
 * is possible.
 *
 * Returns the journal entry ID on success.
 */
export async function confirmInvoiceAndPostGL(
  invoice: Invoice,
  deps: ConfirmInvoiceGLDeps,
): Promise<string | null> {
  if (invoice.status !== "draft") {
    throw new Error("Only draft invoices can be confirmed");
  }

  // 1. Validate account mappings BEFORE the RPC for fast UX feedback.
  if (!deps.hasRequiredAccounts()) {
    throw new Error(
      "Cannot confirm invoice: default account mappings (Accounts Receivable, Sales Revenue, Cash) are not configured. Go to Settings > Default Accounts."
    );
  }
  const accountMappings = deps.getInvoiceAccountMappings();
  if (!accountMappings.receivable_account_id || !accountMappings.revenue_account_id) {
    throw new Error(
      "Cannot confirm invoice: Accounts Receivable and Sales Revenue accounts must be mapped. Go to Settings > Default Accounts."
    );
  }

  // 2. Resolve effective AR account (contact override > system default)
  const customerDefaults = await fetchCustomerDefaults(invoice.contact_id);
  const effectiveReceivableAccountId =
    customerDefaults.default_receivable_account_id || accountMappings.receivable_account_id!;

  // 3. Build pre-resolved JE entries
  // Sales audit Phase F: COGS is NOT posted at invoice confirmation. It is
  // posted exclusively at delivery time by `complete_delivery_atomic`, which
  // matches Odoo and IFRS revenue-recognition rules (COGS recognized when goods
  // physically leave). Posting COGS here AND at delivery double-counts: it
  // understates Inventory and overstates COGS expense. The two postings have
  // different `source_type` (invoice vs delivery_note) so the
  // `assert_no_existing_source_posting` guard does not catch them.
  const lineItems = await fetchInvoiceLinesWithProducts(invoice.id);
  const mainLines: JELine[] = [];

  // DR Accounts Receivable for full invoice total
  mainLines.push({
    account_id: effectiveReceivableAccountId,
    debit: invoice.total,
    credit: 0,
    description: `Invoice ${invoice.invoice_number} - Accounts Receivable`,
    contact_id: invoice.contact_id || null,
  });

  if (lineItems.length > 0 && deps.systemDefaults) {
    // CR revenue grouped by resolved account
    const revenueLines: Array<{ accountId: string; amount: number }> = [];
    for (const line of lineItems) {
      const resolved = resolveLineAccounts(line.product, deps.systemDefaults);
      // line_total is tax-EXCLUSIVE (Odoo convention)
      revenueLines.push({
        accountId: resolved.revenueAccountId || accountMappings.revenue_account_id!,
        amount: Number(line.line_total),
      });
    }

    const grouped = groupByAccount(revenueLines);
    for (const [accountId, amount] of grouped) {
      mainLines.push({
        account_id: accountId,
        debit: 0,
        credit: amount,
        description: `Invoice ${invoice.invoice_number} - Sales Revenue`,
      });
    }
  } else {
    // Fallback: single revenue line at subtotal
    mainLines.push({
      account_id: accountMappings.revenue_account_id!,
      debit: 0,
      credit: invoice.subtotal,
      description: `Invoice ${invoice.invoice_number} - Sales Revenue`,
    });
  }

  // Tax liability
  if (invoice.tax_amount > 0 && accountMappings.tax_liability_account_id) {
    mainLines.push({
      account_id: accountMappings.tax_liability_account_id!,
      debit: 0,
      credit: invoice.tax_amount,
      description: `Invoice ${invoice.invoice_number} - Tax Liability`,
    });
  }

  // 4. Atomic DB call: validates draft → posts JE(s) → flips status → links JE.
  // Default direct-invoice workflow releases stock immediately through an
  // auto-created Delivery Note, so quantity changes remain movement-based and
  // traceable rather than direct product decrements.
  const releaseStock = deps.releaseStock !== false;
  // `p_final_status: 'sent'` makes the RPC the single writer of the canonical
  // post-confirmation status (Odoo "open" / Xero "awaiting payment"); no
  // client-side status overwrite follows.
  const { data, error } = releaseStock
    ? await supabase.rpc("confirm_invoice_and_release_stock_atomic" as any, {
        p_invoice_id: invoice.id,
        p_user_id: deps.userId || null,
        p_main_lines: mainLines as any,
        p_release_stock: true,
        p_warehouse_id: null,
        p_final_status: "sent",
      })
    : await supabase.rpc("confirm_invoice_atomic" as any, {
        p_invoice_id: invoice.id,
        p_user_id: deps.userId || null,
        p_main_lines: mainLines as any,
        p_final_status: "sent",
        // COGS posts only at goods-issue (complete_delivery_atomic) — ADR 0026.
      });


  if (error) {
    const rawMsg = error.message || "Unknown error";
    const looksLikeMappingIssue = /account|mapping|null value in column "account_id"|not.*configured/i.test(rawMsg);
    const hint = looksLikeMappingIssue ? " Check your account mappings." : "";
    throw new Error(`Invoice confirmation failed: ${rawMsg}.${hint}`);
  }

  const result = data as { success: boolean; journal_entry_id: string; cogs_journal_entry_id: string | null; stock_released?: boolean };
  if (!result?.success) {
    throw new Error("Invoice confirmation failed: server returned no success flag");
  }

  // NOTE: Stock movements are NOT created here. Stock is managed via Delivery Notes.

  // 5. Audit log
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

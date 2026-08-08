/**
 * Canonical invoice payability.
 *
 * ADR: an invoice is payable because it has a *residual balance on a posted
 * document*, never because its workflow label happens to appear in a
 * hand-written status array. Status vocabularies drift (`confirmed` vs `sent`),
 * and every drift silently makes a real receivable unpayable and invisible.
 *
 * Open-invoice pickers MUST source rows from `finance_ar_open_items` (the
 * GL-gated projection) via `fetchOpenCustomerInvoices`, so the Receive Payment
 * dialog and the Receivables page can never disagree.
 */

import { supabase } from "@/integrations/supabase/client";

/** Statuses that can never carry a payable receivable. */
export const NON_PAYABLE_INVOICE_STATUSES = [
  "draft",
  "cancelled",
  "voided",
  "void",
  "paid",
] as const;

const RESIDUAL_EPSILON = 0.005;

export interface PayableInvoiceShape {
  status: string;
  total: number;
  amount_paid?: number | null;
}

/** True when the document still carries an outstanding balance an operator may settle. */
export function isInvoicePayable(invoice: PayableInvoiceShape): boolean {
  if (NON_PAYABLE_INVOICE_STATUSES.includes(invoice.status as never)) return false;
  return invoice.total - (invoice.amount_paid ?? 0) > RESIDUAL_EPSILON;
}

/** True when an outstanding document is past its due date. */
export function isInvoiceOverdue(
  invoice: PayableInvoiceShape & { due_date?: string | null },
): boolean {
  if (!isInvoicePayable(invoice)) return false;
  if (!invoice.due_date) return false;
  return new Date(invoice.due_date) < new Date();
}

export interface OpenCustomerInvoice {
  id: string;
  invoice_number: string;
  issue_date: string;
  due_date: string;
  total: number;
  amount_paid: number;
  balance_due: number;
  currency: string;
  status: string;
  contact_id: string;
}

/**
 * Open invoices for one customer, straight off the GL-gated AR projection.
 * Residual there already nets cash receipts AND applied credit notes, so a
 * fully settled invoice can never be offered for payment.
 */
export async function fetchOpenCustomerInvoices(params: {
  orgId: string;
  businessId: string;
  contactId: string;
  branchId?: string | null;
}): Promise<OpenCustomerInvoice[]> {
  const { orgId, businessId, contactId, branchId } = params;

  let q = supabase
    .from("finance_ar_open_items" as never)
    .select(
      "document_id, document_number, document_date, due_date, document_total, applied_amount, residual_amount, document_status, contact_id",
    )
    .eq("organization_id", orgId)
    .eq("business_id", businessId)
    .eq("contact_id", contactId)
    .gt("residual_amount", 0.01);
  if (branchId) q = q.eq("branch_id", branchId);

  const { data, error } = await q;
  if (error) throw error;

  const rows = (data as unknown as Array<Record<string, unknown>>) ?? [];

  // Currency lives on the invoice, not the projection.
  const ids = rows.map((r) => String(r.document_id));
  const currencies = new Map<string, string>();
  if (ids.length > 0) {
    const { data: invs } = await supabase
      .from("invoices")
      .select("id, currency")
      .in("id", ids);
    for (const inv of invs ?? []) currencies.set(inv.id, inv.currency);
  }

  return rows
    .map((r) => {
      const total = Number(r.document_total) || 0;
      const applied = Number(r.applied_amount) || 0;
      return {
        id: String(r.document_id),
        invoice_number: (r.document_number as string) ?? "—",
        issue_date: r.document_date as string,
        due_date: (r.due_date as string) ?? (r.document_date as string),
        total,
        amount_paid: applied,
        balance_due: Number(r.residual_amount) || 0,
        currency: currencies.get(String(r.document_id)) ?? "KES",
        status: (r.document_status as string) ?? "sent",
        contact_id: contactId,
      };
    })
    .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
}

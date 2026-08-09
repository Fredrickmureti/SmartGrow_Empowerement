/**
 * Canonical payment-term resolution for the client.
 *
 * ADR: a document's payment term is resolved by ONE rule, server-side —
 * `public.resolve_payment_term(org, business, contact, override)` — cascading
 * document override -> customer/supplier default -> business default. App code
 * must never re-implement that cascade, and must never invent a "+30 days"
 * fallback: an unresolved term means due on receipt, not an arbitrary month of
 * free credit. The due date derived here is snapshotted on the document and is
 * never re-resolved from master data afterwards, so changing a counterparty's
 * term cannot rewrite the meaning of documents already raised.
 */
import { supabase } from "@/integrations/supabase/client";

export interface ResolvedPaymentTerm {
  payment_term_id: string;
  days: number;
  name: string;
}

export interface ResolvePaymentTermParams {
  organizationId: string | null | undefined;
  businessId: string | null | undefined;
  /** Customer (sales) or vendor (purchases) contact id. */
  contactId?: string | null;
  /** Explicit user choice on the document — wins over every default. */
  overrideTermId?: string | null;
}

/**
 * Resolve the applicable payment term, or null when the organization has no
 * default term configured and neither the counterparty nor the operator chose
 * one. Callers treat null as due on receipt.
 */
export async function resolvePaymentTerm(
  params: ResolvePaymentTermParams,
): Promise<ResolvedPaymentTerm | null> {
  const { organizationId, businessId, contactId, overrideTermId } = params;
  if (!organizationId) return null;

  const { data, error } = await supabase.rpc("resolve_payment_term", {
    p_organization_id: organizationId,
    p_business_id: businessId ?? null,
    p_contact_id: contactId ?? null,
    p_override_term_id: overrideTermId ?? null,
  } as never);

  if (error) throw error;

  const rows = (data as unknown as ResolvedPaymentTerm[] | null) ?? [];
  const row = rows[0];
  if (!row?.payment_term_id) return null;
  return {
    payment_term_id: row.payment_term_id,
    days: Number(row.days) || 0,
    name: row.name,
  };
}

/**
 * Document due date = document date + the term's days. With no term the
 * document is due on receipt (the document date itself).
 */
export function dueDateFromTerm(
  documentDate: string,
  days: number | null | undefined,
): string {
  const base = new Date(`${documentDate}T00:00:00`);
  if (Number.isNaN(base.getTime())) return documentDate;
  base.setDate(base.getDate() + (days ?? 0));
  return base.toISOString().split("T")[0];
}

/** Today in the app's date-input format. */
export function todayIso(): string {
  return new Date().toISOString().split("T")[0];
}
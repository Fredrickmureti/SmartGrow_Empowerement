/**
 * Thin typed wrappers around the P1 supplier lifecycle RPCs.
 *
 * Every RPC below is SECURITY DEFINER, business-scoped, atomic, and
 * emits a `supplier.*` outbox event with idempotency key
 * `<topic>:<entity>:<state>`. UI never mutates supplier tables
 * directly — always go through these wrappers.
 */
import { supabase } from "@/integrations/supabase/client";

export async function submitSupplierQualification(
  supplierId: string,
  payload: Record<string, unknown> = {},
) {
  const { data, error } = await (supabase as any).rpc(
    "submit_supplier_qualification",
    { p_supplier_id: supplierId, p_payload: payload },
  );
  if (error) throw error;
  return data as string;
}

export async function approveSupplierQualification(
  qualificationId: string,
  opts: { score?: number; expiresAt?: string; notes?: string } = {},
) {
  const { data, error } = await (supabase as any).rpc(
    "approve_supplier_qualification",
    {
      p_qualification_id: qualificationId,
      p_score: opts.score ?? null,
      p_expires_at: opts.expiresAt ?? null,
      p_notes: opts.notes ?? null,
    },
  );
  if (error) throw error;
  return data;
}

export async function rejectSupplierQualification(
  qualificationId: string,
  notes: string,
) {
  const { data, error } = await (supabase as any).rpc(
    "reject_supplier_qualification",
    { p_qualification_id: qualificationId, p_notes: notes },
  );
  if (error) throw error;
  return data;
}

export async function suspendSupplier(supplierId: string, reason: string) {
  const { data, error } = await (supabase as any).rpc("suspend_supplier", {
    p_supplier_id: supplierId,
    p_reason: reason,
  });
  if (error) throw error;
  return data;
}

export async function reinstateSupplier(
  supplierId: string,
  notes?: string,
) {
  const { data, error } = await (supabase as any).rpc("reinstate_supplier", {
    p_supplier_id: supplierId,
    p_notes: notes ?? null,
  });
  if (error) throw error;
  return data;
}

/**
 * Server-authoritative supplier creation.
 *
 * Party (contacts) + procurement role (suppliers) are written in one
 * transaction by `public.create_supplier`. Passing `contactId` promotes an
 * existing party to the supplier role (ADR-0038 dual-role) instead of
 * duplicating it. Retries are idempotent: an existing supplier for the same
 * (business, contact) pair is returned rather than re-created.
 */
export interface CreateSupplierInput {
  businessId: string;
  contactId?: string | null;
  name?: string;
  email?: string;
  phone?: string;
  taxId?: string;
  notes?: string;
  supplierCode?: string;
  categoryId?: string | null;
  defaultCurrency?: string;
  defaultIncoterms?: string;
  defaultLeadTimeDays?: number | null;
}

export interface CreateSupplierResult {
  success: boolean;
  error?: string;
  supplier_id?: string;
  contact_id?: string;
  created?: boolean;
}

export async function createSupplier(
  input: CreateSupplierInput,
): Promise<CreateSupplierResult> {
  const { data, error } = await (supabase as any).rpc("create_supplier", {
    p_business_id: input.businessId,
    p_contact_id: input.contactId ?? null,
    p_name: input.name ?? null,
    p_email: input.email ?? null,
    p_phone: input.phone ?? null,
    p_tax_id: input.taxId ?? null,
    p_notes: input.notes ?? null,
    p_supplier_code: input.supplierCode ?? null,
    p_category_id: input.categoryId ?? null,
    p_default_currency: input.defaultCurrency ?? null,
    p_default_incoterms: input.defaultIncoterms ?? null,
    p_default_lead_time_days: input.defaultLeadTimeDays ?? null,
  });
  if (error) throw error;
  const res = (data ?? {}) as CreateSupplierResult;
  if (!res.success) throw new Error(res.error ?? "Failed to create supplier");
  return res;
}

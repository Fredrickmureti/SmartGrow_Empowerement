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

/* ────────────────────────────────────────────────────────────────────────
 * Lifecycle transitions (P1 state machine).
 * Every one is idempotent: repeating a transition that already happened
 * returns `{ noop: true }` and emits no duplicate outbox event.
 * ──────────────────────────────────────────────────────────────────────── */
async function call(fn: string, args: Record<string, unknown>) {
  const { data, error } = await (supabase as any).rpc(fn, args);
  if (error) throw error;
  const res = (data ?? {}) as { success?: boolean; error?: string };
  if (res.success === false) throw new Error(res.error ?? `${fn} failed`);
  return res as Record<string, unknown>;
}

export const approveSupplier = (supplierId: string, notes?: string) =>
  call("approve_supplier", { p_supplier_id: supplierId, p_notes: notes ?? null });

export const blockSupplier = (supplierId: string, reason: string) =>
  call("block_supplier", { p_supplier_id: supplierId, p_reason: reason });

export const unblockSupplier = (supplierId: string, notes?: string) =>
  call("unblock_supplier", { p_supplier_id: supplierId, p_notes: notes ?? null });

export const archiveSupplier = (supplierId: string, reason?: string) =>
  call("archive_supplier", { p_supplier_id: supplierId, p_reason: reason ?? null });

export const unarchiveSupplier = (supplierId: string, notes?: string) =>
  call("unarchive_supplier", { p_supplier_id: supplierId, p_notes: notes ?? null });

/* ── Commercial terms (change-logged) ─────────────────────────────────── */
export interface SupplierTermsInput {
  defaultCurrency?: string | null;
  defaultIncoterms?: string | null;
  defaultPaymentTermId?: string | null;
  defaultLeadTimeDays?: number | null;
  minimumOrderValue?: number | null;
  preferredRank?: number | null;
  reason?: string;
}

export const updateSupplierTerms = (supplierId: string, input: SupplierTermsInput) =>
  call("update_supplier_terms", {
    p_supplier_id: supplierId,
    p_default_currency: input.defaultCurrency ?? null,
    p_default_incoterms: input.defaultIncoterms ?? null,
    p_default_payment_term_id: input.defaultPaymentTermId ?? null,
    p_default_lead_time_days: input.defaultLeadTimeDays ?? null,
    p_minimum_order_value: input.minimumOrderValue ?? null,
    p_preferred_rank: input.preferredRank ?? null,
    p_reason: input.reason ?? null,
  });

/* ── Banking (segregation of duties enforced server-side) ─────────────── */
export interface SupplierBankAccountInput {
  bankName: string;
  accountName: string;
  accountNumber: string;
  currency?: string;
  iban?: string;
  swiftBic?: string;
  branchCode?: string;
  country?: string;
  isPrimary?: boolean;
}

export const addSupplierBankAccount = (
  supplierId: string,
  input: SupplierBankAccountInput,
) =>
  call("add_supplier_bank_account", {
    p_supplier_id: supplierId,
    p_bank_name: input.bankName,
    p_account_name: input.accountName,
    p_account_number: input.accountNumber,
    p_currency: input.currency ?? null,
    p_iban: input.iban ?? null,
    p_swift_bic: input.swiftBic ?? null,
    p_branch_code: input.branchCode ?? null,
    p_country: input.country ?? null,
    p_is_primary: input.isPrimary ?? false,
  });

export const verifySupplierBankAccount = (bankAccountId: string) =>
  call("verify_supplier_bank_account", { p_bank_account_id: bankAccountId });

export const deactivateSupplierBankAccount = (bankAccountId: string, reason?: string) =>
  call("deactivate_supplier_bank_account", {
    p_bank_account_id: bankAccountId,
    p_reason: reason ?? null,
  });

/* ── Compliance ───────────────────────────────────────────────────────── */
export const recordSupplierComplianceCheck = (
  supplierId: string,
  input: {
    checkKind: string;
    outcome: string;
    reference?: string;
    details?: Record<string, unknown>;
    expiresAt?: string;
  },
) =>
  call("record_supplier_compliance_check", {
    p_supplier_id: supplierId,
    p_check_kind: input.checkKind,
    p_outcome: input.outcome,
    p_reference: input.reference ?? null,
    p_details: input.details ?? {},
    p_expires_at: input.expiresAt ?? null,
  });

/* ── Approved supplier list ───────────────────────────────────────────── */
export const addSupplierToAsl = (
  supplierId: string,
  categoryId: string,
  opts: { rank?: number; effectiveFrom?: string; effectiveTo?: string; notes?: string } = {},
) =>
  call("add_supplier_to_asl", {
    p_supplier_id: supplierId,
    p_category_id: categoryId,
    p_rank: opts.rank ?? 1,
    p_effective_from: opts.effectiveFrom ?? null,
    p_effective_to: opts.effectiveTo ?? null,
    p_notes: opts.notes ?? null,
  });

export const removeSupplierFromAsl = (
  supplierId: string,
  categoryId: string,
  reason?: string,
) =>
  call("remove_supplier_from_asl", {
    p_supplier_id: supplierId,
    p_category_id: categoryId,
    p_reason: reason ?? null,
  });

/* ── Document defaults resolution (party → role) ──────────────────────── */
export async function resolveSupplierDefaults(businessId: string, contactId: string) {
  const { data, error } = await (supabase as any).rpc("resolve_supplier_defaults", {
    p_business_id: businessId,
    p_contact_id: contactId,
  });
  if (error) throw error;
  return (data ?? null) as {
    supplier_id: string;
    supplier_code: string | null;
    lifecycle_state: string;
    currency: string | null;
    incoterms: string | null;
    payment_term_id: string | null;
    lead_time_days: number | null;
    minimum_order_value: number | null;
  } | null;
}

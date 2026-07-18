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

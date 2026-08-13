/**
 * Landed cost RPC wrappers.
 *
 * Every state transition of a landed cost voucher (allocate / post / reverse)
 * is owned by the database. The browser never flips a status column: it calls
 * one of these functions, which are the *only* sanctioned mutation path for a
 * voucher once it leaves `draft`.
 */
import { supabase } from "@/integrations/supabase/client";

export interface AllocateResult {
  allocated_count: number;
  total_allocated: number;
  skipped: { reason: string; goods_receipt_item_id?: string }[];
  [key: string]: unknown;
}

export interface PostResult {
  journal_entry_id: string | null;
  capitalized_amount: number;
  expensed_amount: number;
  [key: string]: unknown;
}

function unwrap<T>(data: unknown, error: { message: string } | null): T {
  if (error) throw new Error(error.message);
  return data as T;
}

export async function allocateLandedCostVoucher(voucherId: string) {
  const { data, error } = await supabase.rpc("landed_cost_allocate_voucher", {
    p_voucher_id: voucherId,
  });
  return unwrap<AllocateResult>(data, error);
}

export async function postLandedCostVoucher(voucherId: string) {
  const { data, error } = await supabase.rpc("landed_cost_post_voucher", {
    p_voucher_id: voucherId,
  });
  return unwrap<PostResult>(data, error);
}

export async function reverseLandedCostVoucher(voucherId: string, reason: string) {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error("A reversal reason is required.");
  const { data, error } = await supabase.rpc("landed_cost_reverse_voucher", {
    p_voucher_id: voucherId,
    p_reason: trimmed,
  });
  return unwrap<Record<string, unknown>>(data, error);
}

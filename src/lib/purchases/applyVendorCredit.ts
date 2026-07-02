/**
 * Vendor credit application helper.
 *
 * Thin wrapper around the SECURITY DEFINER RPC `apply_vendor_credit_atomic`
 * which:
 *   1. Locks the bill + VCN rows (FOR UPDATE) — prevents race conditions
 *      when two operators apply credit to the same bill simultaneously.
 *   2. Inserts a `vendor_credit_note_applications` row.
 *   3. Inserts a synthetic `bill_payments` row (method='vendor_credit', no GL)
 *      so the bill's payment history reflects the credit application.
 *   4. Updates `bills.amount_paid` + status (paid/partial).
 *   5. Updates `vendor_credit_notes.amount_applied` + status (applied/partial).
 *
 * GL was posted at VCN confirmation (Dr AP, Cr Expense) — we do NOT
 * post again here to avoid double-counting AP reduction.
 */
import { supabase } from "@/integrations/supabase/client";

export interface ApplyCreditResult {
  success: boolean;
  applied_amount?: number;
  bill_remaining?: number;
  vcn_remaining?: number;
  error?: string;
}

export async function applyVendorCreditToBill(args: {
  vcnId: string;
  billId: string;
  amount: number;
  userId: string;
}): Promise<ApplyCreditResult> {
  const { data, error } = await supabase.rpc(
    "apply_vendor_credit_atomic" as any,
    {
      p_vcn_id: args.vcnId,
      p_bill_id: args.billId,
      p_amount: args.amount,
      p_user_id: args.userId,
    },
  );

  if (error) {
    return { success: false, error: error.message };
  }
  return data as ApplyCreditResult;
}

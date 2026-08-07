/**
 * Vendor credit application helper — FIFO multi-bill (ADR 0132).
 *
 * Thin wrapper around `apply_vendor_credit_fifo_atomic`. The RPC:
 *  1. Locks the VCN and reads availability from `vendor_credit_balances`,
 *     the projection of append-only `vendor_credit_movements` — never from
 *     `vendor_credit_notes.total - amount_applied`.
 *  2. Allocates the available credit across open bills, FIFO by
 *     `bills.due_date` (NULLS LAST), then created_at.
 *  3. Delegates each allocation to `apply_vendor_credit_to_bill_atomic`,
 *     which writes the application row, the `apply` credit movement and the
 *     journal entry (through `post_journal_entry_atomic` only).
 *
 * No client code resolves GL accounts, builds journal lines, or decides which
 * bills a credit lands on.
 */
import { supabase } from "@/integrations/supabase/client";

export interface CreditAllocation {
  bill_id: string;
  amount: number;
}

export interface ApplyCreditResult {
  success: boolean;
  total_applied?: number;
  credit_remaining?: number;
  allocations?: CreditAllocation[];
  error?: string;
}

/**
 * Apply an issued vendor credit note FIFO across one or many bills.
 * Pass `billIds` to restrict allocation to a specific set; omit for
 * "any open bill for this vendor + currency".
 */
export async function applyVendorCreditNote(args: {
  organizationId: string;
  businessId: string;
  creditNoteId: string;
  billIds?: string[];
  userId: string;
  branchId?: string | null;
}): Promise<ApplyCreditResult> {
  const { data, error } = await supabase.rpc(
    "apply_vendor_credit_fifo_atomic" as any,
    {
      _org_id: args.organizationId,
      _business_id: args.businessId,
      _vendor_credit_note_id: args.creditNoteId,
      _bill_ids: args.billIds ?? null,
      _applied_by: args.userId,
      _branch_id: args.branchId ?? null,
    },
  );

  if (error) {
    return { success: false, error: error.message };
  }
  return data as ApplyCreditResult;
}

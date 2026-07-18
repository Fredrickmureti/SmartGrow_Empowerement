/**
 * Vendor credit application helper — FIFO multi-bill (Batch I-Deferred).
 *
 * Thin wrapper around `apply_vendor_credit_note_atomic`. The RPC:
 *  1. Locks the VCN + eligible bills (FOR UPDATE) — race-safe.
 *  2. Allocates the confirmed VCN's remaining balance across one or many
 *     open bills, FIFO by `bills.due_date` (NULLS LAST), then created_at.
 *  3. Inserts one `vendor_credit_note_applications` row per allocation.
 *  4. Updates each touched bill's `amount_paid` and status.
 *  5. Updates the VCN's `amount_applied` and status.
 *  6. Emits a `procurement.credit.applied` outbox event for Finance / Audit.
 *
 * GL was already posted at VCN confirmation (Dr AP, Cr Expense); this RPC
 * does not touch the ledger to avoid double-counting the AP reduction.
 *
 * SoD: the user who confirmed the VCN cannot also apply it. Enforced in RPC.
 */
import { supabase } from "@/integrations/supabase/client";

export interface CreditAllocation {
  bill_id: string;
  amount: number;
  new_balance: number;
}

export interface ApplyCreditResult {
  success: boolean;
  idempotent?: boolean;
  total_applied?: number;
  credit_remaining?: number;
  allocations?: CreditAllocation[];
  outbox_event_id?: string;
  error?: string;
}

/**
 * Apply a confirmed vendor credit note FIFO across one or many bills.
 * Pass `billIds` to restrict allocation to a specific set; omit for
 * "any open bill for this vendor + currency".
 */
export async function applyVendorCreditNote(args: {
  creditNoteId: string;
  billIds?: string[];
  userId: string;
}): Promise<ApplyCreditResult> {
  const { data, error } = await supabase.rpc(
    "apply_vendor_credit_note_atomic" as any,
    {
      p_credit_note_id: args.creditNoteId,
      p_bill_ids: args.billIds ?? null,
      p_user_id: args.userId,
    },
  );

  if (error) {
    return { success: false, error: error.message };
  }
  return data as ApplyCreditResult;
}

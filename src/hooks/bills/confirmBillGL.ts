/**
 * Bill confirmation — thin wrapper around the atomic RPC `confirm_bill_atomic`.
 *
 * Previous versions ran four sequential client-side writes (status update →
 * fetch lines → postToGL → link journal_entry_id) with best-effort rollback.
 * That window allowed orphaned journal entries when the browser died between
 * GL post and JE link.
 *
 * The RPC now does everything in one DB transaction:
 *   - locks the bill, validates draft state and tenant scope
 *   - resolves per-line product / inventory / vendor expense accounts
 *   - resolves the vendor's AP override (contacts.default_payable_account_id)
 *     falling back to the system Accounts Payable mapping
 *   - posts a balanced JE (Dr Expense / Inventory / Input Tax, Cr AP)
 *   - flips bills.status='received' and links journal_entry_id
 *
 * Failures are atomic — there is no partial state to roll back on the client.
 */
import { supabase } from "@/integrations/supabase/client";
import type { Bill } from "../useBills";

interface ConfirmBillGLDeps {
  logAction: (opts: {
    action: "confirmed";
    entityType: "bill";
    entityId: string;
    entityName: string;
    oldValues?: Record<string, unknown>;
    newValues?: Record<string, unknown>;
    changesSummary?: string;
  }) => void;
  userId?: string;
}

/**
 * Confirms a bill (draft → received) and posts to the General Ledger atomically.
 * Returns the journal entry ID on success.
 */
export async function confirmBillAndPostGL(
  bill: Bill,
  deps: ConfirmBillGLDeps,
): Promise<string | null> {
  if (bill.status !== "draft") {
    throw new Error("Only draft bills can be confirmed");
  }

  const { data, error } = await supabase.rpc("confirm_bill_atomic" as any, {
    _bill_id: bill.id,
    _user_id: deps.userId ?? null,
  });

  if (error) {
    throw new Error(
      `Bill confirmation failed: ${error.message}`,
    );
  }

  const result = (data ?? {}) as {
    success?: boolean;
    journal_entry_id?: string | null;
  };

  if (result.success === false) {
    throw new Error("Bill confirmation failed (RPC reported failure).");
  }

  deps.logAction({
    action: "confirmed",
    entityType: "bill",
    entityId: bill.id,
    entityName: bill.bill_number,
    oldValues: { status: "draft" },
    newValues: { status: "received" },
    changesSummary: `Confirmed bill ${bill.bill_number} and posted to GL`,
  });

  return result.journal_entry_id ?? null;
}

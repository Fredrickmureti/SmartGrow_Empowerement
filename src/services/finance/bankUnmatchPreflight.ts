/**
 * Un-match pre-flight — client seam.
 *
 * ADR-0149: un-matching a reconciled bank line is an accounting act, and the
 * conditions under which it is refused live in SQL
 * (`unreconcile_bank_transaction`). This module is the ONLY caller of
 * `bank_unmatch_preflight`, a read-only mirror of those same refusals, so the
 * workspace can tell the accountant *before* the click what will happen and
 * why it cannot happen.
 *
 * The pre-flight never authorises anything: the RPC that mutates re-checks
 * every condition itself. A stale "allowed" answer is therefore harmless.
 */

import { supabase } from "@/integrations/supabase/client";

/** What un-matching would do, when it is allowed. */
export type UnmatchConsequence =
  | "void_payment"
  | "void_journal_entry"
  | "link_only"
  | null;

export interface UnmatchPreflight {
  allowed: boolean;
  /** Stable machine code — never render this raw. */
  code: string;
  /** Server-authored sentence, already written for an accountant. */
  reason: string;
  requires: UnmatchConsequence | string | null;
  /** The resolution kind the line was reconciled as, when known. */
  resolution?: string | null;
}

export async function fetchUnmatchPreflight(
  bankTransactionId: string,
): Promise<UnmatchPreflight> {
  const { data, error } = await (supabase as any).rpc("bank_unmatch_preflight", {
    _bank_transaction_id: bankTransactionId,
  });
  if (error) throw error;

  const row = (data ?? {}) as Partial<UnmatchPreflight>;
  return {
    allowed: row.allowed === true,
    code: row.code ?? "UNKNOWN",
    reason: row.reason ?? "This action could not be checked.",
    requires: row.requires ?? null,
    resolution: row.resolution ?? null,
  };
}

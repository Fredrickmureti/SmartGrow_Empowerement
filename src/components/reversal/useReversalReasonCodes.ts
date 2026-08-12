/**
 * useReversalReasonCodes — the ONE client source of the reversal vocabulary
 * (ADR 0129, Phase 5.2).
 *
 * The catalog lives in `public.reversal_reason_codes` and is validated
 * server-side by `assert_reversal_reason` inside every canonical reversal
 * writer. Never hard-code a reason list in a dialog: a screen-local list forks
 * the vocabulary and the server will reject codes it does not know.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type ReversalDocumentType =
  | "invoice"
  | "payment"
  | "bill"
  | "bill_payment"
  | "goods_receipt"
  | "expense"
  | "vendor_credit_note"
  | "pos_transaction"
  | "payroll_run";

export interface ReversalReasonCode {
  code: string;
  label: string;
  description: string | null;
  requires_comment: boolean;
  sort_order: number;
}

export function useReversalReasonCodes(
  documentType: ReversalDocumentType,
  enabled = true,
) {
  const query = useQuery({
    queryKey: ["reversal-reason-codes", documentType],
    enabled,
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<ReversalReasonCode[]> => {
      const { data, error } = await supabase
        .from("reversal_reason_codes" as any)
        .select("code, label, description, requires_comment, sort_order")
        .eq("active", true)
        .contains("applies_to", [documentType])
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as ReversalReasonCode[];
    },
  });

  return {
    reasonCodes: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * Mirrors the server rule in `assert_reversal_reason`: a code must be chosen,
 * and codes flagged `requires_comment` need a written explanation. Kept here so
 * the confirm button disables instead of the operator discovering it via a
 * database error.
 */
export function isReversalReasonComplete(
  reasonCodes: ReversalReasonCode[],
  code: string,
  comment: string,
): boolean {
  if (!code) return false;
  const selected = reasonCodes.find((r) => r.code === code);
  if (!selected) return false;
  if (selected.requires_comment && !comment.trim()) return false;
  return true;
}

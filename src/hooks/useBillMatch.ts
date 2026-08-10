/**
 * useBillMatch — read side of the single bill matcher.
 *
 * `bill_match_results` is written by `match_bill_atomic` and by nothing else
 * (ratcheted in `src/test/architecture/bill-match-single-writer.test.ts`).
 * These hooks only read it, plus the one server-side review RPC
 * `resolve_bill_match_exception_atomic`.
 */
import { useCallback, useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import type { BillMatchResult } from "@/features/purchases/bills/matchState";

const SELECT =
  "bill_id, match_state, exception_state, qty_variance, price_variance, landed_cost_uplift, matched_at, matched_by, purchase_order_id";

function coerce(row: Record<string, unknown>): BillMatchResult {
  return {
    bill_id: String(row.bill_id),
    match_state: row.match_state as BillMatchResult["match_state"],
    exception_state: row.exception_state as BillMatchResult["exception_state"],
    qty_variance: Number(row.qty_variance ?? 0),
    price_variance: Number(row.price_variance ?? 0),
    landed_cost_uplift: Number(row.landed_cost_uplift ?? 0),
    matched_at: (row.matched_at as string | null) ?? null,
    matched_by: (row.matched_by as string | null) ?? null,
    purchase_order_id: (row.purchase_order_id as string | null) ?? null,
  };
}

/** Match results for a page of bills, keyed by `bill_id`. */
export function useBillMatchResults(billIds: string[]) {
  const [results, setResults] = useState<Record<string, BillMatchResult>>({});
  const key = billIds.slice().sort().join(",");

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) {
      setResults({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("bill_match_results")
        .select(SELECT)
        .in("bill_id", ids);
      if (cancelled || error || !data) return;
      const next: Record<string, BillMatchResult> = {};
      for (const row of data as Record<string, unknown>[]) {
        const r = coerce(row);
        next[r.bill_id] = r;
      }
      setResults(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  return results;
}

/** Match result for one bill, with the reviewer decision action. */
export function useBillMatch(billId: string | null | undefined) {
  const { toast } = useToast();
  const [result, setResult] = useState<BillMatchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);

  const refresh = useCallback(async () => {
    if (!billId) {
      setResult(null);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from("bill_match_results")
      .select(SELECT)
      .eq("bill_id", billId)
      .maybeSingle();
    setLoading(false);
    if (error) return;
    setResult(data ? coerce(data as Record<string, unknown>) : null);
  }, [billId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resolveException = useCallback(
    async (decision: "approved" | "rejected", note?: string) => {
      if (!billId) return false;
      setResolving(true);
      try {
        const { data: userRes } = await supabase.auth.getUser();
        const { error } = await supabase.rpc("resolve_bill_match_exception_atomic", {
          _bill_id: billId,
          _decision: decision,
          _note: note ?? null,
          _actor: userRes.user?.id ?? null,
        });
        if (error) throw error;
        toast({
          title: decision === "approved" ? "Variance accepted" : "Variance rejected",
          description:
            decision === "approved"
              ? "The bill can now continue through approval."
              : "The bill stays blocked until the supplier invoice or the receipt is corrected.",
        });
        await refresh();
        return true;
      } catch (err) {
        toast({
          title: "Could not record the decision",
          description: normalizeError(err).message,
          variant: "destructive",
        });
        return false;
      } finally {
        setResolving(false);
      }
    },
    [billId, refresh, toast],
  );

  return { result, loading, resolving, refresh, resolveException };
}

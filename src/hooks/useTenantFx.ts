/**
 * useTenantFx — tenant-side DISPLAY currency conversion.
 *
 * ADR 0136: there is one rate book (`public.exchange_rates`) and one lookup
 * (`@/services/fx/rateBook`). This hook is a thin, org-scoped reader over
 * that book — it does not implement a second FX engine and it never invents
 * a rate. When no rate is on file, `convert()`/`rate()` return `null` so the
 * caller renders an honest "missing FX rate" state (Odoo / Xero / QBO
 * behaviour) instead of a misleading 1:1 total.
 *
 * Accounting rates (booking, settlement, realized gain/loss) are resolved
 * SERVER-side by `resolve_exchange_rate` / `require_exchange_rate`. Nothing
 * here may be used to post.
 */
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { resolveRateFromBook, type RateBookRow } from "@/services/fx/rateBook";

export interface TenantFx {
  /** True while the rate book is loading. */
  isLoading: boolean;
  /**
   * Convert `amount` from `from` to `to`. Returns `null` when no rate path
   * exists (caller MUST render a missing-rate UI state, not a silent 0/1:1).
   */
  convert: (amount: number, from: string, to: string, asOf?: string) => number | null;
  /** Resolve a single rate `from → to`. Returns null if no path. */
  rate: (from: string, to: string, asOf?: string) => number | null;
}

export function useTenantFx(): TenantFx {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const baseCurrency = currentBusiness?.base_currency ?? null;

  const { data: rates, isLoading } = useQuery({
    queryKey: ["fx-rate-book", currentOrg?.id ?? null],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("exchange_rates")
        .select("from_currency,to_currency,rate,effective_date,source")
        .eq("organization_id", currentOrg!.id)
        .order("effective_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as RateBookRow[];
    },
    staleTime: 5 * 60_000,
  });

  const rate = useCallback(
    (from: string, to: string, asOf?: string): number | null =>
      resolveRateFromBook(rates, from, to, asOf, baseCurrency),
    [rates, baseCurrency],
  );

  const convert = useCallback(
    (amount: number, from: string, to: string, asOf?: string): number | null => {
      const r = rate(from, to, asOf);
      return r === null ? null : amount * r;
    },
    [rate],
  );

  return { isLoading, convert, rate };
}

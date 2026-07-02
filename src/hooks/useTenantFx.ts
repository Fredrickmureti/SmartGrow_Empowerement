/**
 * useTenantFx — tenant-side currency conversion engine.
 *
 * Mirrors the admin-side `useAdminCurrency` engine but is safe to call from
 * any tenant component. Reads `platform_exchange_rates` (USD-canonical),
 * triangulates through USD, and refuses to invent a rate. When a rate is
 * missing, `convert()` returns `null` so callers can render an honest
 * "missing FX rate" state instead of silently using 1:1.
 *
 * Why this exists:
 *   - Banking "Total Balance" (and any future multi-currency aggregate) must
 *     not silently fall back to USD. Odoo, Xero and QuickBooks all hide or
 *     warn when no rate is configured rather than displaying a misleading
 *     number.
 */
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

interface ExchangeRateRow {
  from_currency: string;
  to_currency: string;
  rate: number;
  is_active: boolean;
}

export interface TenantFx {
  /** True while the rates table is loading. */
  isLoading: boolean;
  /**
   * Convert `amount` from `from` to `to`. Returns `null` when no rate path
   * exists (caller MUST render a missing-rate UI state, not a silent 0/1:1).
   */
  convert: (amount: number, from: string, to: string) => number | null;
  /** Resolve a single rate `from → to`. Returns null if no path. */
  rate: (from: string, to: string) => number | null;
}

export function useTenantFx(): TenantFx {
  const { data: rates, isLoading } = useQuery({
    queryKey: ["platform-exchange-rates", "tenant"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("platform_exchange_rates")
        .select("from_currency,to_currency,rate,is_active")
        .eq("is_active", true);
      if (error) throw error;
      return (data ?? []) as ExchangeRateRow[];
    },
    staleTime: 5 * 60_000,
  });

  const rate = useCallback(
    (from: string, to: string): number | null => {
      const f = (from || "").toUpperCase();
      const t = (to || "").toUpperCase();
      if (!f || !t) return null;
      if (f === t) return 1;
      const rs = rates ?? [];
      // Direct
      const direct = rs.find((r) => r.from_currency === f && r.to_currency === t);
      if (direct && Number(direct.rate) > 0) return Number(direct.rate);
      // Reverse
      const reverse = rs.find((r) => r.from_currency === t && r.to_currency === f);
      if (reverse && Number(reverse.rate) > 0) return 1 / Number(reverse.rate);
      // Triangulate via USD: f → USD, USD → t
      if (f !== "USD" && t !== "USD") {
        const fToUsd =
          rs.find((r) => r.from_currency === f && r.to_currency === "USD") ??
          (() => {
            const rev = rs.find((r) => r.from_currency === "USD" && r.to_currency === f);
            return rev && Number(rev.rate) > 0
              ? ({ from_currency: f, to_currency: "USD", rate: 1 / Number(rev.rate), is_active: true } as ExchangeRateRow)
              : null;
          })();
        const usdToT =
          rs.find((r) => r.from_currency === "USD" && r.to_currency === t) ??
          (() => {
            const rev = rs.find((r) => r.from_currency === t && r.to_currency === "USD");
            return rev && Number(rev.rate) > 0
              ? ({ from_currency: "USD", to_currency: t, rate: 1 / Number(rev.rate), is_active: true } as ExchangeRateRow)
              : null;
          })();
        if (fToUsd && usdToT) return Number(fToUsd.rate) * Number(usdToT.rate);
      }
      return null;
    },
    [rates],
  );

  const convert = useCallback(
    (amount: number, from: string, to: string): number | null => {
      const r = rate(from, to);
      if (r === null) return null;
      return amount * r;
    },
    [rate],
  );

  return { isLoading, convert, rate };
}
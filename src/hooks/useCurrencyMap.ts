/**
 * useCurrencyMap — runtime cache of the canonical `public.currencies` table.
 *
 * Returned as a `Record<code, { code, symbol, decimal_places }>` so any
 * pricing UI can resolve symbols and decimal places without ever hardcoding
 * the answer in JS. Replaces the per-file inline symbol maps that previously
 * only knew about USD/EUR/GBP.
 *
 * Cached for 30 minutes — currency metadata changes about never.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { CurrencyMap } from "@/lib/pricing/formatAppPrice";

export function useCurrencyMap() {
  const { data, isLoading } = useQuery({
    queryKey: ["currencies-map"],
    queryFn: async (): Promise<CurrencyMap> => {
      const { data, error } = await supabase
        .from("currencies")
        .select("code, symbol, decimal_places")
        .eq("is_active", true);
      if (error) throw error;
      const map: CurrencyMap = {};
      for (const row of data ?? []) {
        map[row.code] = {
          code: row.code,
          symbol: row.symbol,
          decimal_places: row.decimal_places ?? 2,
        };
      }
      return map;
    },
    staleTime: 30 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  });

  return { currencyMap: data, isLoading };
}

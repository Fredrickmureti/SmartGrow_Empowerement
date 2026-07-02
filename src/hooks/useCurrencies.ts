import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface Currency {
  code: string;
  name: string;
  symbol: string;
  decimal_places: number;
}

/**
 * Fetches all active currencies from the canonical `public.currencies` table.
 * Replaces hardcoded `SUPPORTED_CURRENCIES` lists scattered across the UI so
 * the picker never drifts from the system's source of truth.
 */
export function useCurrencies() {
  const query = useQuery({
    queryKey: ["currencies-list"],
    queryFn: async (): Promise<Currency[]> => {
      const { data, error } = await supabase
        .from("currencies")
        .select("code, name, symbol, decimal_places")
        .eq("is_active", true)
        .order("code");

      if (error) throw error;

      return (data || []).map((c) => ({
        code: c.code,
        name: c.name,
        symbol: c.symbol,
        decimal_places: c.decimal_places ?? 2,
      }));
    },
    staleTime: 1000 * 60 * 30, // 30 min — reference data rarely changes
  });

  return {
    currencies: query.data || [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

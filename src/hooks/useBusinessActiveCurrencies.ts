/**
 * useBusinessActiveCurrencies — the currencies a business is allowed to
 * transact in (ADR 0135/0136).
 *
 * The canonical catalogue is `public.currencies`; a business narrows it via
 * `business_active_currencies`. Any money-bearing form must pick from THIS
 * list, never a free-text box and never a hardcoded literal: the server-side
 * seams (e.g. `bank_account_create`) validate against exactly this set, so a
 * picker fed from anywhere else can only produce a rejected write or, worse,
 * a currency the rate book has no coverage for.
 *
 * When a business has published no explicit list, the base currency is the
 * only enabled currency — we do NOT silently fall back to the full catalogue.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrencies, type Currency } from "@/hooks/useCurrencies";

export function useBusinessActiveCurrencies() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id ?? null;
  const baseCurrency = currentBusiness?.base_currency ?? null;
  const { currencies: catalogue, isLoading: catalogueLoading } = useCurrencies();

  const enabled = useQuery({
    queryKey: ["business-active-currencies", businessId],
    enabled: !!businessId,
    staleTime: 1000 * 60 * 10,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from("business_active_currencies")
        .select("currency_code")
        .eq("business_id", businessId!)
        .eq("is_enabled", true);
      if (error) throw error;
      return (data || []).map((r) => r.currency_code.toUpperCase());
    },
  });

  const codes = new Set<string>(enabled.data ?? []);
  if (baseCurrency) codes.add(baseCurrency.toUpperCase());

  const currencies: Currency[] = catalogue.filter((c) =>
    codes.has(c.code.toUpperCase()),
  );

  return {
    currencies,
    baseCurrency,
    isLoading: catalogueLoading || enabled.isLoading,
    error: enabled.error,
  };
}

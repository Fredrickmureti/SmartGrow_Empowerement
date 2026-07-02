import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface Country {
  code: string;
  name: string;
  currency: string; // default_currency from countries table
  region?: string;
  phone_code?: string;
}

/**
 * Fetches all active countries from the database `countries` table.
 * Replaces the old hardcoded `getCountryList()` from countryCurrency.ts.
 */
export function useCountries() {
  const query = useQuery({
    queryKey: ["countries"],
    queryFn: async (): Promise<Country[]> => {
      const { data, error } = await (supabase.from as any)("countries")
        .select("code, name, default_currency, region, phone_code")
        .eq("is_active", true)
        .order("name");

      if (error) throw error;

      return (data || []).map((c: any) => ({
        code: c.code,
        name: c.name,
        currency: c.default_currency || "USD", // architecture-allow: display-only fallback
        region: c.region,
        phone_code: c.phone_code,
      }));
    },
    staleTime: 1000 * 60 * 60, // 1 hour — reference data rarely changes
  });

  return {
    countries: query.data || [],
    isLoading: query.isLoading,
    error: query.error,
  };
}

/**
 * Get the default currency for a country code from the loaded countries list.
 */
export function getCurrencyByCountryCode(
  countries: Country[],
  countryCode: string
): string {
  return countries.find((c) => c.code === countryCode)?.currency || "USD"; // architecture-allow: display-only fallback
}

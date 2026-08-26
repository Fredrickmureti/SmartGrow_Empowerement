/**
 * useBusinessCurrencies — the currencies this business is actually allowed to
 * transact in, resolved on the server.
 *
 * Never hardcode a currency list in a form: the tenant decides which currencies
 * are enabled, and the same rule is enforced in the database (a project whose
 * currency is not enabled for its business is rejected), so the picker must be
 * fed from the same source of truth.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface BusinessCurrency {
  currency_code: string;
  is_enabled: boolean;
  is_base: boolean;
}

export function useBusinessCurrencies() {
  const { currentBusiness } = useBusinesses();
  const [currencies, setCurrencies] = useState<BusinessCurrency[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const businessId = currentBusiness?.id;

  const fetchCurrencies = useCallback(async () => {
    if (!businessId) {
      setCurrencies([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    const { data, error } = await supabase.rpc("list_business_active_currencies", {
      _business_id: businessId,
    });
    if (error) {
      console.error("Error loading business currencies:", error);
      setCurrencies([]);
    } else {
      setCurrencies(((data ?? []) as BusinessCurrency[]).filter((c) => c.is_enabled !== false));
    }
    setIsLoading(false);
  }, [businessId]);

  useEffect(() => {
    void fetchCurrencies();
  }, [fetchCurrencies]);

  const baseCurrency =
    currencies.find((c) => c.is_base)?.currency_code ??
    (currentBusiness?.base_currency ?? "").toUpperCase() ??
    "";

  return {
    currencies,
    currencyCodes: currencies.map((c) => c.currency_code),
    baseCurrency,
    isLoading,
    refresh: fetchCurrencies,
  };
}

/**
 * Same contract as `useBusinessCurrencies`, for an explicitly chosen company
 * rather than the currently selected one. Needed wherever a form names the
 * company it is configuring (e.g. a consolidation group's parent), because the
 * enabled-currency rule is enforced per company in the database.
 */
export function useBusinessCurrenciesFor(businessId: string | null | undefined) {
  const [currencies, setCurrencies] = useState<BusinessCurrency[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!businessId) {
      setCurrencies([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void supabase
      .rpc("list_business_active_currencies", { _business_id: businessId })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Error loading company currencies:", error);
          setCurrencies([]);
        } else {
          setCurrencies(
            ((data ?? []) as BusinessCurrency[]).filter((c) => c.is_enabled !== false),
          );
        }
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  return { currencies, isLoading };
}


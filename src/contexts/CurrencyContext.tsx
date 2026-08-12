// @ts-nocheck
import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface Currency {
  id: string;
  code: string;
  name: string;
  symbol: string;
  decimal_places: number;
  is_active: boolean;
}

export interface ExchangeRate {
  id: string;
  organization_id: string;
  from_currency: string;
  to_currency: string;
  rate: number;
  effective_date: string;
}

interface CurrencyContextType {
  currencies: Currency[];
  exchangeRates: ExchangeRate[];
  baseCurrency: string;
  isReady: boolean;
  isLoading: boolean;
  formatCurrency: (amount: number, currencyCode?: string) => string;
  getCurrencySymbol: (currencyCode?: string) => string;
  /** Resolved rate, or `null` when no rate is on file. NEVER silently 1. */
  getExchangeRate: (fromCurrency: string, toCurrency: string, date?: string) => number | null;
  /** Converted amount, or `null` when no rate is on file. */
  convertCurrency: (amount: number, fromCurrency: string, toCurrency: string, date?: string) => number | null;
  addExchangeRate: (fromCurrency: string, toCurrency: string, rate: number, effectiveDate?: string) => Promise<void>;
  refreshCurrencies: () => Promise<void>;
  refreshExchangeRates: () => Promise<void>;
}

const STORAGE_KEY = "bookflow_base_currency";

const CurrencyContext = createContext<CurrencyContextType | undefined>(undefined);

export function CurrencyProvider({ children }: { children: React.ReactNode }) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currenciesLoaded, setCurrenciesLoaded] = useState(false);

  // Initialize baseCurrency from localStorage for instant access (no flash)
  const [baseCurrency, setBaseCurrency] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(STORAGE_KEY) || "USD";
    }
    return "USD";
  });

  // Sync baseCurrency when current business loads/changes (Phase-7: business is source of truth)
  useEffect(() => {
    if (currentBusiness?.base_currency) {
      const newCurrency = currentBusiness.base_currency;
      setBaseCurrency(newCurrency);
      localStorage.setItem(STORAGE_KEY, newCurrency);
    }
  }, [currentBusiness?.base_currency]);

  const fetchCurrencies = useCallback(async () => {
    try {
      const { data, error } = await supabase
        // SCOPE-EXEMPT: `currencies` is workspace-wide (no business_id column)
        .from("currencies")
        .select("*")
        .eq("is_active", true)
        .order("code");

      if (error) throw error;
      setCurrencies(data || []);
      setCurrenciesLoaded(true);
    } catch (error) {
      console.error("Error fetching currencies:", error);
      setCurrenciesLoaded(true);
    }
  }, []);

  const fetchExchangeRates = useCallback(async () => {
    if (!currentOrg) return;

    try {
      const { data, error } = await supabase
        .from("exchange_rates")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .order("effective_date", { ascending: false });

      if (error) throw error;
      setExchangeRates(data || []);
    } catch (error) {
      console.error("Error fetching exchange rates:", error);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      await Promise.all([fetchCurrencies(), fetchExchangeRates()]);
      setIsLoading(false);
    };
    load();
  }, [fetchCurrencies, fetchExchangeRates]);

  const formatCurrency = useCallback(
    (amount: number, currencyCode?: string): string => {
      const code = currencyCode || baseCurrency;
      const currency = currencies.find((c) => c.code === code);
      
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: code,
          minimumFractionDigits: currency?.decimal_places ?? 2,
          maximumFractionDigits: currency?.decimal_places ?? 2,
        }).format(amount);
      } catch {
        // Fallback for unsupported currency codes
        const symbol = currency?.symbol || code;
        return `${symbol}${amount.toFixed(currency?.decimal_places ?? 2)}`;
      }
    },
    [baseCurrency, currencies]
  );

  const getCurrencySymbol = useCallback(
    (currencyCode?: string): string => {
      const code = currencyCode || baseCurrency;
      const currency = currencies.find((c) => c.code === code);
      return currency?.symbol || code;
    },
    [baseCurrency, currencies]
  );

  /**
   * Display-only rate lookup against the ONE accounting rate book
   * (`public.exchange_rates`), mirroring the precedence of the server-side
   * `resolve_exchange_rate`: override > manual > provider, most recent
   * effective date first.
   *
   * Returns `null` when nothing is on file. It never invents 1 — the browser
   * may display a rate, it may not compute an accounting one (ADR 0136).
   */
  const rankSource = (s?: string) => (s === "override" ? 0 : s === "manual" ? 1 : 2);

  const pickRate = useCallback(
    (from: string, to: string, targetDate: string): number | null => {
      const candidates = exchangeRates
        .filter(
          (r) =>
            (r.from_currency || "").toUpperCase() === from &&
            (r.to_currency || "").toUpperCase() === to &&
            r.effective_date <= targetDate,
        )
        .sort((a, b) => {
          if (a.effective_date !== b.effective_date) return a.effective_date < b.effective_date ? 1 : -1;
          return rankSource((a as any).source) - rankSource((b as any).source);
        });
      const hit = candidates[0];
      return hit && Number(hit.rate) > 0 ? Number(hit.rate) : null;
    },
    [exchangeRates],
  );

  const getExchangeRate = useCallback(
    (fromCurrency: string, toCurrency: string, date?: string): number | null => {
      const from = (fromCurrency || "").toUpperCase();
      const to = (toCurrency || "").toUpperCase();
      if (!from || !to) return null;
      if (from === to) return 1;

      const targetDate = date || new Date().toISOString().split("T")[0];

      const direct = pickRate(from, to, targetDate);
      if (direct !== null) return direct;

      const reverse = pickRate(to, from, targetDate);
      if (reverse !== null) return 1 / reverse;

      // Triangulate through the business base currency — the pivot every
      // published rate is expressed against.
      const pivot = (baseCurrency || "").toUpperCase();
      if (pivot && from !== pivot && to !== pivot) {
        const fromToPivot = pickRate(from, pivot, targetDate);
        const toToPivot = pickRate(to, pivot, targetDate);
        if (fromToPivot !== null && toToPivot !== null && toToPivot !== 0) {
          return fromToPivot / toToPivot;
        }
      }

      return null;
    },
    [pickRate, baseCurrency],
  );

  const convertCurrency = useCallback(
    (amount: number, fromCurrency: string, toCurrency: string, date?: string): number | null => {
      const rate = getExchangeRate(fromCurrency, toCurrency, date);
      if (rate === null) return null;
      return amount * rate;
    },
    [getExchangeRate]
  );

  /**
   * A tenant-entered rate is an OVERRIDE: it outranks the provider-published
   * row for the same day and never mutates it.
   */
  const addExchangeRate = async (
    fromCurrency: string,
    toCurrency: string,
    rate: number,
    effectiveDate?: string
  ) => {
    if (!currentOrg) throw new Error("No organization selected");

    const { error } = await supabase.from("exchange_rates").insert({
      organization_id: currentOrg.id,
      business_id: currentBusiness?.id ?? null,
      from_currency: fromCurrency.toUpperCase(),
      to_currency: toCurrency.toUpperCase(),
      rate,
      effective_date: effectiveDate || new Date().toISOString().split("T")[0],
      source: "override",
    });

    if (error) throw error;
    await fetchExchangeRates();
  };

  // isReady is true when we have a cached currency OR when currencies have loaded
  const isReady = useMemo(() => {
    // If we have a cached baseCurrency from localStorage and it's not the default "USD",
    // we're ready immediately
    const cachedCurrency = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (cachedCurrency && cachedCurrency !== "USD") {
      return true;
    }
    // Otherwise, wait for currencies to load
    return currenciesLoaded;
  }, [currenciesLoaded]);

  const value = useMemo(
    () => ({
      currencies,
      exchangeRates,
      baseCurrency,
      isReady,
      isLoading,
      formatCurrency,
      getCurrencySymbol,
      getExchangeRate,
      convertCurrency,
      addExchangeRate,
      refreshCurrencies: fetchCurrencies,
      refreshExchangeRates: fetchExchangeRates,
    }),
    [
      currencies,
      exchangeRates,
      baseCurrency,
      isReady,
      isLoading,
      formatCurrency,
      getCurrencySymbol,
      getExchangeRate,
      convertCurrency,
      fetchCurrencies,
      fetchExchangeRates,
    ]
  );

  return (
    <CurrencyContext.Provider value={value}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrencyContext() {
  const context = useContext(CurrencyContext);
  if (context === undefined) {
    throw new Error("useCurrencyContext must be used within a CurrencyProvider");
  }
  return context;
}
